-- Tipo do lembrete de confirmar presença (CLU-67), gravado pelo passo diário
-- notify_meeting_reminders(). Fica numa migration própria porque o Postgres
-- não deixa usar um valor novo de enum na mesma transação em que ele foi
-- criado. Valor de enum não sai mais do banco depois do deploy.
ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'ATTENDANCE_CONFIRMATION_REMINDER';
  