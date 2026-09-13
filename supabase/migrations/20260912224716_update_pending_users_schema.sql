ALTER TABLE public.pending_users 
  DROP COLUMN IF EXISTS address,
  ADD COLUMN IF NOT EXISTS city varchar,
  ADD COLUMN IF NOT EXISTS zone varchar;
