DO $$ BEGIN
CREATE TYPE public.book_status AS ENUM (
    'DRAWN',
    'CURRENT',
    'AVAILABLE'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE public.book_suggestions
ALTER COLUMN book_status TYPE public.book_status
USING book_status::text::public.book_status;