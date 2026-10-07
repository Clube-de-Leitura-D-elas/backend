CREATE TYPE public.book_status AS ENUM (
    'DRAWN',
    'CURRENT',
    'AVAILABLE'
);

ALTER TABLE public.book_suggestions
ALTER COLUMN book_status TYPE public.book_status
USING book_status::text::public.book_status;

ALTER TABLE public.book_suggestions
ALTER COLUMN book_status DROP DEFAULT;

ALTER TABLE public.book_suggestions
ALTER COLUMN book_status DROP NOT NULL;