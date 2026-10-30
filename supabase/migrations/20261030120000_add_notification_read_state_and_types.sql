ALTER TABLE public.notifications_targets
  ADD COLUMN IF NOT EXISTS read_at timestamp with time zone;

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_REMINDER';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_SCHEDULE_PENDING';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'DRAW_RESULT';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_UPDATED';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.notifications,
  public.notifications_targets
TO service_role;
