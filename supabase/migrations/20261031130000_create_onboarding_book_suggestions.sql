-- Indicação de livro feita no cadastro (CLU-274): texto livre, sem livro
-- cadastrado, sem grupo e fora do sorteio.
--
-- A 20260927000000 tentou guardá-la em book_suggestions com name + user_id,
-- mas book_id, group_user_id, suggested_at e book_status são NOT NULL e o
-- insert do claim-user-profile sempre falhava. book_suggestions continua só
-- com as indicações de livro do grupo, que concorrem no sorteio.
--
-- RLS: como o resto do schema, a tabela é acessada só pelas edge functions
-- com service role.

CREATE TABLE public.onboarding_book_suggestions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_book_suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT onboarding_book_suggestions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.onboarding_book_suggestions
TO service_role;

-- Preserva alguma linha que tenha sido gravada com todos os campos antes de
-- remover as colunas.
INSERT INTO public.onboarding_book_suggestions (user_id, name, created_at)
SELECT user_id, name, suggested_at
FROM public.book_suggestions
WHERE name IS NOT NULL
  AND user_id IS NOT NULL;

ALTER TABLE public.book_suggestions
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS user_id;
