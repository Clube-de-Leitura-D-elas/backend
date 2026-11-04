ALTER TABLE public.books
    ADD CONSTRAINT books_external_id_key UNIQUE (external_id);