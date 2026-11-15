CREATE OR REPLACE FUNCTION public.normalize_book_search(
  value text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT translate(
    lower(value),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
$$;

CREATE OR REPLACE FUNCTION public.search_books_catalog(
  p_query text,
  p_offset integer,
  p_limit integer
)
RETURNS TABLE (
  book_id uuid,
  popularity bigint
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH recent_reviews AS (
    SELECT
      br.book_id,
      count(*) AS total
    FROM public.book_reviews br
    WHERE br.evaluated_at >= now() - interval '30 days'
    GROUP BY br.book_id
  ),
  recent_suggestions AS (
    SELECT
      bs.book_id,
      count(*) AS total
    FROM public.book_suggestions bs
    WHERE bs.suggested_at >= now() - interval '30 days'
    GROUP BY bs.book_id
  ),
  ranked_books AS (
    SELECT
      b.id,
      b.name,
      (
        coalesce(rr.total, 0) +
        coalesce(rs.total, 0)
      )::bigint AS score
    FROM public.books b
    LEFT JOIN recent_reviews rr
      ON rr.book_id = b.id
    LEFT JOIN recent_suggestions rs
      ON rs.book_id = b.id
    WHERE (
      p_query IS NULL
      OR (
        position(
          public.normalize_book_search(p_query)
          IN public.normalize_book_search(b.name)
        ) > 0
        OR position(
          public.normalize_book_search(p_query)
          IN public.normalize_book_search(b.author)
        ) > 0
      )
    )
  )
  SELECT
    rb.id AS book_id,
    rb.score AS popularity
  FROM ranked_books rb
  WHERE p_query IS NOT NULL OR rb.score > 0
  ORDER BY
    CASE
      WHEN p_query IS NULL THEN rb.score
    END DESC NULLS LAST,
    rb.name ASC,
    rb.id ASC
  LIMIT p_limit
  OFFSET p_offset;
$$;

REVOKE ALL ON FUNCTION public.normalize_book_search(text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.search_books_catalog(
  text, integer, integer
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.search_books_catalog(
  text, integer, integer
)
TO service_role;