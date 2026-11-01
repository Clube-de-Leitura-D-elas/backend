-- Estante da leitora, sinopse dos livros e unicidade de avaliações e
-- indicações (CLU-256).

-- ---------------------------------------------------------
-- Estante: livros que a leitora quer ler ou já leu
-- ---------------------------------------------------------
CREATE TYPE public.reading_status AS ENUM (
  'WANT_TO_READ',
  'READ'
);

-- RLS ativo e sem policies: anon e authenticated não leem nem escrevem pela
-- REST, mesmo que recebam privilégios por default. As edge functions usam a
-- service role, que ignora RLS.
CREATE TABLE public.user_books (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  book_id uuid NOT NULL,
  status public.reading_status NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_books_pkey PRIMARY KEY (id),
  CONSTRAINT user_books_user_id_book_id_key UNIQUE (user_id, book_id),
  CONSTRAINT user_books_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT user_books_book_id_fkey
    FOREIGN KEY (book_id) REFERENCES public.books(id)
);

ALTER TABLE public.user_books ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_books
TO service_role;

-- ---------------------------------------------------------
-- Sinopse
-- ---------------------------------------------------------
ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS synopsis text;

-- ---------------------------------------------------------
-- Uma avaliação por leitora e livro
-- ---------------------------------------------------------
-- Mantém a avaliação mais recente de cada leitora para o livro.
DELETE FROM public.book_reviews br
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, book_id
           ORDER BY evaluated_at DESC, id
         ) AS position
  FROM public.book_reviews
) ranked
WHERE br.id = ranked.id
  AND ranked.position > 1;

ALTER TABLE public.book_reviews
  ADD CONSTRAINT book_reviews_user_id_book_id_key UNIQUE (user_id, book_id);

-- ---------------------------------------------------------
-- Uma indicação por livro em cada grupo
-- ---------------------------------------------------------
-- O grupo só era conhecido via group_user_id → group_users.group_id, e uma
-- unique não atravessa join. Toda indicação tem group_user_id, então toda
-- linha recebe grupo no backfill (a indicação do cadastro fica em
-- onboarding_book_suggestions desde a 20261031130000).
ALTER TABLE public.book_suggestions
  ADD COLUMN group_id uuid;

UPDATE public.book_suggestions bs
SET group_id = gu.group_id
FROM public.group_users gu
WHERE gu.id = bs.group_user_id;

-- Livro indicado mais de uma vez no mesmo grupo: fica a indicação que já saiu
-- da concorrência (sorteada ou em leitura) ou, entre as disponíveis, a mais
-- antiga. As removidas estão sempre disponíveis, então nenhum sorteio aponta
-- para elas.
DELETE FROM public.book_suggestions bs
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY group_id, book_id
           ORDER BY (book_status <> 'AVAILABLE') DESC, suggested_at, id
         ) AS position
  FROM public.book_suggestions
) ranked
WHERE bs.id = ranked.id
  AND ranked.position > 1
  AND bs.book_status = 'AVAILABLE';

ALTER TABLE public.book_suggestions
  ALTER COLUMN group_id SET NOT NULL,
  ADD CONSTRAINT book_suggestions_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES public.groups(id),
  ADD CONSTRAINT book_suggestions_group_id_book_id_key UNIQUE (group_id, book_id);

-- O grupo agora aparece em group_id e via group_user_id → group_users.group_id.
-- A FK composta garante que os dois batem; sem ela, um group_id errado furaria
-- a unicidade por grupo.
ALTER TABLE public.group_users
  ADD CONSTRAINT group_users_id_group_id_key UNIQUE (id, group_id);

ALTER TABLE public.book_suggestions
  ADD CONSTRAINT book_suggestions_group_user_group_fkey
    FOREIGN KEY (group_user_id, group_id)
    REFERENCES public.group_users(id, group_id);
