DROP TABLE IF EXISTS public.meeting_guests;

ALTER TABLE public.meeting_group_users RENAME TO meeting_users;
ALTER TABLE public.meeting_users ADD COLUMN user_id uuid;

UPDATE public.meeting_users AS mu
SET user_id = gu.user_id
FROM public.group_users AS gu
WHERE gu.id = mu.group_user_id;

ALTER TABLE public.meeting_users
  ALTER COLUMN user_id SET NOT NULL,
  ADD CONSTRAINT meeting_users_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id),
  ADD CONSTRAINT meeting_users_meeting_id_user_id_key
    UNIQUE (meeting_id, user_id);

ALTER TABLE public.meeting_users DROP COLUMN group_user_id;