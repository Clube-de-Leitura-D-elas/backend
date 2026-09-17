ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS book_name varchar;
