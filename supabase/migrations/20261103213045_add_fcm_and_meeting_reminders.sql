-- 1. Token do Firebase na tabela public.users
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS fcm_token text,
  ADD COLUMN IF NOT EXISTS fcm_token_updated_at timestamptz;

-- 2. Flag de controle para evitar disparos duplicados na tabela public.meetings
ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS reminder_1_week_sent boolean NOT NULL DEFAULT false;

-- 3. Índice para acelerar a busca de reuniões pendentes de aviso
CREATE INDEX IF NOT EXISTS idx_meetings_reminder_1_week
  ON public.meetings (date)
  WHERE NOT reminder_1_week_sent;

-- 4. Extensões pg_net e pg_cron
CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron SCHEMA extensions;
