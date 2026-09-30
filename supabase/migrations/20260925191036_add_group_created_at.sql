ALTER TABLE public.groups
ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now();
