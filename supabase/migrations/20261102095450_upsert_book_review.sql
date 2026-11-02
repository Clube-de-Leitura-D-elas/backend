-- Avaliação de livro pela leitora (CLU-259, edge function
-- `upsert-book-review`).
--
-- `upsert_book_review` grava ou substitui a avaliação da leitora e marca o
-- livro como READ em `user_books` numa transação só: avaliar implica "Já lido",
-- e uma falha na segunda escrita não pode deixar a avaliação sem a estante.
-- Devolve também a média e a contagem do livro, calculadas na mesma transação,
-- para a function responder sem outra consulta (e sem o limite de max_rows).
--
-- Reavaliar substitui nota, comentário e evaluated_at. Não altera dados
-- existentes. A função só pode ser executada pela service role.

CREATE OR REPLACE FUNCTION public.upsert_book_review(
  p_user_id uuid,
  p_book_id uuid,
  p_rating real,
  p_commentary varchar
)
RETURNS TABLE (
  id uuid,
  rating real,
  commentary varchar,
  evaluated_at timestamp with time zone,
  rating_average double precision,
  ratings_count bigint
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  review public.book_reviews;
BEGIN
  INSERT INTO public.book_reviews AS br
    (user_id, book_id, rating, commentary, evaluated_at)
  VALUES
    (p_user_id, p_book_id, p_rating, p_commentary, now())
  ON CONFLICT ON CONSTRAINT book_reviews_user_id_book_id_key DO UPDATE
  SET rating = EXCLUDED.rating,
      commentary = EXCLUDED.commentary,
      evaluated_at = EXCLUDED.evaluated_at
  RETURNING br.* INTO review;

  INSERT INTO public.user_books AS ub (user_id, book_id, status, updated_at)
  VALUES (p_user_id, p_book_id, 'READ', now())
  ON CONFLICT ON CONSTRAINT user_books_user_id_book_id_key DO UPDATE
  SET status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at;

  RETURN QUERY
  SELECT review.id, review.rating, review.commentary, review.evaluated_at,
         avg(r.rating)::double precision, count(*)
  FROM public.book_reviews r
  WHERE r.book_id = p_book_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_book_review(uuid, uuid, real, varchar)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_book_review(uuid, uuid, real, varchar)
TO service_role;
