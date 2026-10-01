-- A member can have one attendance response for each meeting. The constraint
-- also makes the Edge Function's upsert atomic under concurrent requests.
DELETE FROM public.meeting_group_users AS duplicate
USING public.meeting_group_users AS retained
WHERE duplicate.meeting_id = retained.meeting_id
  AND duplicate.group_user_id = retained.group_user_id
  AND duplicate.ctid > retained.ctid;

ALTER TABLE public.meeting_group_users
  ADD CONSTRAINT meeting_group_users_meeting_id_group_user_id_key
  UNIQUE (meeting_id, group_user_id);
