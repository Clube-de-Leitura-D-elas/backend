CREATE TYPE public.presence_status AS ENUM (
    'PRESENT',
    'ABSENT'
);

CREATE TYPE public.invitation_status AS ENUM (
    'PENDING',
    'CONFIRMED',
    'DECLINED'
);

ALTER TABLE public.meeting_group_users
ADD COLUMN IF NOT EXISTS invitation_status public.invitation_status
NOT NULL DEFAULT 'PENDING';

ALTER TABLE public.meeting_group_users
ALTER COLUMN presence_status TYPE public.presence_status
USING presence_status::text::public.presence_status;

ALTER TABLE public.meeting_group_users
ALTER COLUMN presence_status DROP DEFAULT;

ALTER TABLE public.meeting_group_users
ALTER COLUMN presence_status DROP NOT NULL;