DO $$ BEGIN
CREATE TYPE public.registration_status AS ENUM (
    'ACTIVE',
    'PENDING',
    'INACTIVE',
    'GUEST'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE public.group_users
ALTER COLUMN registration_status TYPE public.registration_status
USING registration_status::text::public.registration_status;