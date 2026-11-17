-- Base comum para criar avisos (CLU-296). Até aqui nada gravava em
-- `notifications`, e cada aviso do épico reinventaria a escrita.
--
-- `dedup_key` impede aviso duplicado quando o mesmo evento ou job roda de
-- novo. Formato: <TYPE>:<id do evento>[:<marco>], por exemplo
-- DRAW_RESULT:<meeting_raffle_id> ou MEETING_REMINDER:<meeting_id>:1d. É
-- nullable porque nem todo aviso vem de um evento repetível; o UNIQUE não
-- compara NULLs. A coluna entra vazia em todas as linhas, então o UNIQUE não
-- encontra duplicatas.
--
-- `create_notification` grava a notificação e uma linha por destinatária em
-- `notifications_targets` na mesma transação. Pode ser chamada de dentro de
-- outra função SQL, na transação do próprio evento, ou por RPC. Só a service
-- role executa; quem chama de outra função SQL precisa rodar como ela.
--
-- Os tipos novos do épico entram junto com o primeiro fluxo que os grava:
-- valor de enum não sai mais do banco depois do deploy.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedup_key text;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_dedup_key_key UNIQUE (dedup_key);

-- A get-my-notifications filtra os alvos por usuária na lista e no
-- unread_count; sem índice, as duas consultas varrem a tabela inteira.
CREATE INDEX IF NOT EXISTS notifications_targets_user_id_idx
  ON public.notifications_targets (user_id);

-- meeting_id e group_id ficam juntos em notifications_targets. A FK composta
-- garante no banco que o grupo é o do encontro, e o CHECK impede encontro sem
-- grupo (a FK composta não confere a linha quando uma das colunas é NULL).
-- Aviso só de grupo, sem encontro, continua válido. O backfill alinha linhas
-- antigas ao grupo do encontro antes das constraints (hoje nada grava avisos,
-- então não deve haver nenhuma). NO ACTION como as outras FKs da tabela: mudar
-- o grupo de um encontro com avisos falha em vez de deixá-los no grupo errado.
UPDATE public.notifications_targets nt
SET group_id = m.group_id
FROM public.meetings m
WHERE m.id = nt.meeting_id
  AND nt.group_id IS DISTINCT FROM m.group_id;

ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_id_group_id_key UNIQUE (id, group_id);

ALTER TABLE public.notifications_targets
  ADD CONSTRAINT notifications_targets_meeting_group_fkey
  FOREIGN KEY (meeting_id, group_id)
  REFERENCES public.meetings (id, group_id);

ALTER TABLE public.notifications_targets
  ADD CONSTRAINT notifications_targets_meeting_requires_group
  CHECK (meeting_id IS NULL OR group_id IS NOT NULL);

-- Com dedup_key já usada, devolve o id existente sem mudar título, mensagem
-- nem destinatárias, mesmo que a nova lista venha vazia. Se a chamada informa
-- p_scheduled_for e o aviso ainda não apareceu, passa a valer a nova data: um
-- lembrete de encontro remarcado acompanha o encontro. Sem p_scheduled_for, a
-- data existente fica; aviso que já apareceu não muda.
--
-- Aviso novo: p_scheduled_for omitido vale agora. p_user_ids são ids de
-- public.users; ids que não existem lá (removidos, ou de auth.users por engano)
-- são descartados com WARNING no log, para um id inválido não desfazer o
-- evento que chamou a função. Sem destinatária válida, não cria nada e devolve
-- NULL. Com p_meeting_id, o grupo vem do encontro quando p_group_id não é
-- passado.
CREATE OR REPLACE FUNCTION public.create_notification(
  p_type public.notification_type,
  p_title text,
  p_message text,
  p_user_ids uuid[],
  p_meeting_id uuid DEFAULT NULL,
  p_group_id uuid DEFAULT NULL,
  p_scheduled_for timestamp with time zone DEFAULT NULL,
  p_dedup_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  requested_count integer;
  recipient_ids uuid[];
  target_group_id uuid := p_group_id;
  result_id uuid;
BEGIN
  IF p_dedup_key IS NOT NULL THEN
    SELECT n.id
    INTO result_id
    FROM public.notifications n
    WHERE n.dedup_key = p_dedup_key
    FOR UPDATE;

    IF result_id IS NOT NULL THEN
      UPDATE public.notifications n
      SET scheduled_for = p_scheduled_for
      WHERE n.id = result_id
        AND p_scheduled_for IS NOT NULL
        AND n.scheduled_for > now();

      RETURN result_id;
    END IF;
  END IF;

  SELECT count(DISTINCT given_id)
  INTO requested_count
  FROM unnest(p_user_ids) AS given_id;

  SELECT array_agg(DISTINCT u.id)
  INTO recipient_ids
  FROM unnest(p_user_ids) AS given_id
  JOIN public.users u ON u.id = given_id;

  IF coalesce(cardinality(recipient_ids), 0) < requested_count THEN
    RAISE WARNING 'create_notification %: % of % recipients not found in public.users',
      coalesce(p_dedup_key, p_type::text),
      requested_count - coalesce(cardinality(recipient_ids), 0),
      requested_count;
  END IF;

  IF recipient_ids IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_meeting_id IS NOT NULL AND target_group_id IS NULL THEN
    SELECT m.group_id
    INTO target_group_id
    FROM public.meetings m
    WHERE m.id = p_meeting_id;
  END IF;

  -- O conflito aqui só acontece se outra transação criou a mesma chave depois
  -- da busca acima; nesse caso vale o aviso dela.
  INSERT INTO public.notifications
    (title, message, type, scheduled_for, dedup_key)
  VALUES
    (p_title, p_message, p_type, coalesce(p_scheduled_for, now()), p_dedup_key)
  ON CONFLICT (dedup_key) DO NOTHING
  RETURNING id INTO result_id;

  IF result_id IS NULL THEN
    SELECT n.id
    INTO result_id
    FROM public.notifications n
    WHERE n.dedup_key = p_dedup_key;

    RETURN result_id;
  END IF;

  INSERT INTO public.notifications_targets
    (notification_id, user_id, meeting_id, group_id)
  SELECT result_id, recipient_id, p_meeting_id, target_group_id
  FROM unnest(recipient_ids) AS recipient_id;

  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_notification(
  public.notification_type, text, text, uuid[], uuid, uuid,
  timestamp with time zone, text
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_notification(
  public.notification_type, text, text, uuid[], uuid, uuid,
  timestamp with time zone, text
)
TO service_role;
