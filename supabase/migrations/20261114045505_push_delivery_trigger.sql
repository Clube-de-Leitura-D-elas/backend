-- Gatilho do envio de push (CLU-300). Toda notificação gravada em
-- notifications_targets precisa chegar ao aparelho da leitora pela edge
-- function send-push, e quem sabe de todo insert é o banco: a
-- create_notification é chamada por functions, por funções SQL e pelo job
-- diário, e um gatilho cobre todas sem mudar nenhuma delas.
--
-- Isto reintroduz o pg_net, que a 20261107232020_simplify_approval_flow.sql
-- tirou do fluxo de aprovação ("o banco deixa de ser cliente HTTP"). Aqui ele
-- volta só para o push, por decisão da CLU-300.
--
-- Secrets do Vault (cadastrados fora do repositório, em cada ambiente):
--   edge_base_url: URL base das functions, sem barra final
--                  (https://<projeto>.supabase.co/functions/v1).
--   edge_api_key:  chave secreta do projeto (sb_secret_...). A send-push usa
--                  auth "secret", que lê a chave no header apikey e NÃO aceita
--                  o JWT antigo de service_role.
-- Sem os dois secrets, nada é enviado, o insert da notificação segue normal e
-- fica um WARNING no log do Postgres.
--
-- push_sent_at marca o alvo cujo envio foi ENFILEIRADO no pg_net, não
-- entregue: o resultado do FCM não volta para o banco, e quem trata token
-- inválido e falha é a send-push (só loga). NULL significa "ainda não
-- enfileirado", e é o que o passo diário send_pending_pushes procura.
--
-- Backfill: alvos cuja notificação já apareceu (scheduled_for <= agora)
-- ganham push_sent_at = agora, senão o primeiro passo diário dispararia push
-- de avisos antigos. Alvos de avisos ainda agendados para o futuro ficam NULL
-- de propósito: quando a data chegar, o passo diário os envia. Marcar também
-- esses faria o lembrete já agendado nunca gerar push.
--
-- Limite do agendador: o passo roda dentro do job diário das 09:00 de São
-- Paulo. Um aviso agendado para as 15h só sai por push no dia seguinte às
-- 09:00 (a notificação in-app aparece às 15h). Avisos criados já devidos saem
-- na hora, pelo gatilho. Quem falhou no gatilho (secret ausente, erro do
-- pg_net) é reenviado pelo passo diário; avisos devidos há mais de 2 dias são
-- descartados do push (marcados como tratados) para um problema de
-- configuração resolvido tarde não despejar um monte de avisos velhos.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

ALTER TABLE public.notifications_targets
  ADD COLUMN IF NOT EXISTS push_sent_at timestamp with time zone;

UPDATE public.notifications_targets nt
SET push_sent_at = now()
FROM public.notifications n
WHERE n.id = nt.notification_id
  AND n.scheduled_for <= now()
  AND nt.push_sent_at IS NULL;

-- O passo diário só olha os alvos ainda não enfileirados, que são poucos.
CREATE INDEX IF NOT EXISTS notifications_targets_push_pending_idx
  ON public.notifications_targets (notification_id)
  WHERE push_sent_at IS NULL;

-- Chama a send-push para os alvos informados (em lotes de 500, o limite da
-- function) e marca push_sent_at. Nunca lança: qualquer erro vira WARNING e
-- desfaz o lote inteiro (as chamadas do pg_net enfileiradas e as marcas), para
-- o passo diário tentar de novo.
CREATE OR REPLACE FUNCTION public.send_push_for_targets(p_target_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  base_url text;
  api_key text;
  chunk_size constant integer := 500;
  chunk uuid[];
  position integer := 1;
BEGIN
  IF coalesce(cardinality(p_target_ids), 0) = 0 THEN
    RETURN;
  END IF;

  SELECT s.decrypted_secret INTO base_url
  FROM vault.decrypted_secrets s
  WHERE s.name = 'edge_base_url';

  SELECT s.decrypted_secret INTO api_key
  FROM vault.decrypted_secrets s
  WHERE s.name = 'edge_api_key';

  IF base_url IS NULL OR api_key IS NULL THEN
    RAISE WARNING 'send_push_for_targets: secrets edge_base_url e edge_api_key ausentes no Vault, push não enviado';
    RETURN;
  END IF;

  WHILE position <= cardinality(p_target_ids) LOOP
    chunk := p_target_ids[position : position + chunk_size - 1];

    PERFORM net.http_post(
      url := base_url || '/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', api_key
      ),
      body := jsonb_build_object('target_ids', to_jsonb(chunk)),
      timeout_milliseconds := 30000
    );

    UPDATE public.notifications_targets
    SET push_sent_at = now()
    WHERE id = ANY (chunk);

    position := position + chunk_size;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'send_push_for_targets: % (%)', SQLERRM, SQLSTATE;
END;
$$;

-- Gatilho por instrução: um insert de 100 destinatárias vira uma chamada à
-- send-push, não cem. Só envia os alvos cuja notificação já é devida. O
-- gatilho nunca pode derrubar o insert da notificação: erro vira WARNING.
CREATE OR REPLACE FUNCTION public.push_new_notification_targets()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  due_ids uuid[];
BEGIN
  SELECT array_agg(nt.id)
  INTO due_ids
  FROM new_targets nt
  JOIN public.notifications n ON n.id = nt.notification_id
  WHERE n.scheduled_for <= now();

  PERFORM public.send_push_for_targets(due_ids);

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push_new_notification_targets: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE TRIGGER notifications_targets_push
AFTER INSERT ON public.notifications_targets
REFERENCING NEW TABLE AS new_targets
FOR EACH STATEMENT
EXECUTE FUNCTION public.push_new_notification_targets();

-- Passo do job diário (registrado em scheduled_notification_steps): envia os
-- avisos que estavam agendados para o futuro e já venceram, e reenvia os que
-- o gatilho não conseguiu enfileirar.
CREATE OR REPLACE FUNCTION public.send_pending_pushes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pending_ids uuid[];
BEGIN
  UPDATE public.notifications_targets nt
  SET push_sent_at = now()
  FROM public.notifications n
  WHERE n.id = nt.notification_id
    AND nt.push_sent_at IS NULL
    AND n.scheduled_for <= now() - interval '2 days';

  SELECT array_agg(nt.id)
  INTO pending_ids
  FROM public.notifications_targets nt
  JOIN public.notifications n ON n.id = nt.notification_id
  WHERE nt.push_sent_at IS NULL
    AND n.scheduled_for <= now();

  PERFORM public.send_push_for_targets(pending_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.send_push_for_targets(uuid[])
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.send_push_for_targets(uuid[])
TO service_role;

REVOKE ALL ON FUNCTION public.push_new_notification_targets()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.push_new_notification_targets()
TO service_role;

REVOKE ALL ON FUNCTION public.send_pending_pushes()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.send_pending_pushes()
TO service_role;

INSERT INTO public.scheduled_notification_steps (function_name)
VALUES ('send_pending_pushes')
ON CONFLICT (function_name) DO NOTHING;
