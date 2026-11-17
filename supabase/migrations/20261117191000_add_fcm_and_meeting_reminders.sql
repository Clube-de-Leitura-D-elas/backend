-- Adiciona colunas de token FCM em public.users e flag de lembrete de 1 semana
-- em public.meetings. Usa IF NOT EXISTS para ser idempotente em ambientes onde
-- as colunas já existem.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS fcm_token text,
  ADD COLUMN IF NOT EXISTS fcm_token_updated_at timestamptz;

-- Evita que usuárias autenticadas leiam fcm_token de outras contas pela Data API.
REVOKE SELECT (fcm_token, fcm_token_updated_at) ON TABLE public.users FROM authenticated;

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS reminder_1_week_sent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_meetings_reminder_1_week
  ON public.meetings (date)
  WHERE NOT reminder_1_week_sent;
