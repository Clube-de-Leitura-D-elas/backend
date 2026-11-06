-- CLU-257: permite que a Edge Function execute a normalização
-- utilizada internamente pela busca de livros.

GRANT EXECUTE ON FUNCTION public.normalize_book_search(text)
TO service_role;