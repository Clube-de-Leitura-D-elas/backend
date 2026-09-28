-- Adds onboarding book suggestion columns to book_suggestions.
-- The existing table tracks in-group suggestions via book_id + group_user_id.
-- The claim flow needs to store a free-text book name and a direct user reference.

ALTER TABLE public.book_suggestions
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE;
