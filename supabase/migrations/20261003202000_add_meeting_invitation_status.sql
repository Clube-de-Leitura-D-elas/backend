-- An invitation response is distinct from the attendance registered after a
-- meeting. Existing attendance records have no historical invitation response.
ALTER TABLE public.meeting_group_users
  ADD COLUMN invitation_status varchar;

ALTER TABLE public.meeting_group_users
  ADD CONSTRAINT meeting_group_users_invitation_status_check
  CHECK (
    invitation_status IS NULL
    OR invitation_status IN ('CONFIRMED', 'DECLINED')
  );
