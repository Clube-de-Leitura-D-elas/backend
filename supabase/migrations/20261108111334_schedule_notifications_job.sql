-- Agendador dos lembretes que dependem de tempo (CLU-298). Condições como
-- "ainda não confirmou presença?" ou "encontro ainda sem local?" só podem ser
-- avaliadas perto da data, e até aqui nada rodava periodicamente no banco.
--
-- O pg_cron chama public.run_scheduled_notifications() todo dia às 09:00 de
-- São Paulo. O cron do Supabase roda em UTC e o Brasil não tem horário de
-- verão desde 2019, então 09:00 em São Paulo é sempre 12:00 UTC.
--
-- Cada lembrete é uma função SQL própria, sem argumentos, registrada como uma
-- linha em scheduled_notification_steps. Registrar por linha, em vez de cada
-- story recriar o orquestrador com a sua chamada, evita que duas stories em
-- paralelo (CLU-67/68/69) recriem a função e uma apague o passo da outra sem
-- conflito no git. A tabela entra vazia: esta issue entrega só o orquestrador.
--
-- A idempotência fica com cada passo: ele grava pela create_notification com
-- dedup_key, então rodar o job de novo no mesmo dia não duplica aviso.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- function_name é só o nome, sem schema: o orquestrador sempre chama public.<nome>().
CREATE TABLE public.scheduled_notification_steps (
  function_name text PRIMARY KEY CHECK (function_name ~ '^[a-z_][a-z0-9_]*$'),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduled_notification_steps
TO service_role;

ALTER TABLE public.scheduled_notification_steps ENABLE ROW LEVEL SECURITY;

-- Uma linha por passo que falhou em cada execução. O job continua "succeeded"
-- em cron.job_run_details quando um passo falha, e ninguém olha o log do
-- Postgres por conta própria: sem esta tabela, um lembrete pode passar semanas
-- sem sair. function_name não tem FK para scheduled_notification_steps, para
-- o histórico ficar mesmo depois que o passo é removido. Cresce no máximo uma
-- linha por passo falho por dia, então não há limpeza por enquanto.
CREATE TABLE public.scheduled_notification_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  sqlstate text NOT NULL,
  message text NOT NULL,
  failed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_notification_failures_failed_at_idx
  ON public.scheduled_notification_failures (failed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduled_notification_failures
TO service_role;

ALTER TABLE public.scheduled_notification_failures ENABLE ROW LEVEL SECURITY;

-- Cada passo roda no seu próprio bloco BEGIN ... EXCEPTION: se falhar, só o
-- que ele gravou é desfeito, a falha é gravada em
-- scheduled_notification_failures (e no log do Postgres como WARNING) e os
-- passos seguintes rodam. Passo registrado cuja função não existe falha do
-- mesmo jeito, sem parar os outros. Se a execução inteira estourar o
-- statement_timeout do job, tudo é desfeito, inclusive as falhas gravadas
-- nela; esse caso aparece como "failed" em cron.job_run_details.
CREATE OR REPLACE FUNCTION public.run_scheduled_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  step text;
BEGIN
  FOR step IN
    SELECT s.function_name
    FROM public.scheduled_notification_steps s
    ORDER BY s.function_name
  LOOP
    BEGIN
      EXECUTE format('SELECT public.%I()', step);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_scheduled_notifications %: % (%)',
        step, SQLERRM, SQLSTATE;

      INSERT INTO public.scheduled_notification_failures
        (function_name, sqlstate, message)
      VALUES (step, SQLSTATE, SQLERRM);
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.run_scheduled_notifications()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.run_scheduled_notifications()
TO service_role;

-- cron.schedule com nome atualiza o job existente em vez de criar outro.
--
-- O job roda como postgres, que não tem statement_timeout: sem limite, um
-- passo travado segura o job indefinidamente. O SET fica no comando do job
-- porque SET statement_timeout na própria função não tem efeito (o timer é
-- armado no início do comando, antes de a função rodar). O limite vale para a
-- execução inteira; se estourar, o job aparece como "failed" e os passos que
-- já rodaram são desfeitos (rodam de novo no dia seguinte, sem duplicar).
SELECT cron.schedule(
  'run-scheduled-notifications',
  '0 12 * * *',
  $$SET statement_timeout = '5min'; SELECT public.run_scheduled_notifications();$$
);
