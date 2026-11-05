-- O id do volume no Google Books (`external_id`) passa a identificar o livro:
-- a integração faz upsert por ele, então não pode haver dois livros com o
-- mesmo `external_id`.
--
-- Dados existentes: não há limpeza automática. Unificar duplicatas exigiria
-- repontar as FKs de meetings, book_suggestions, book_reviews, user_books e
-- meeting_raffles, e escolher qual linha fica depende de quem conhece os dados.
-- Se houver duplicata, a migration aborta com a mensagem abaixo; a consulta
-- que confirma que não há está no PR.
DO $$
DECLARE
    duplicated integer;
BEGIN
    SELECT count(*) INTO duplicated
    FROM (
        SELECT external_id
        FROM public.books
        GROUP BY external_id
        HAVING count(*) > 1
    ) AS d;

    IF duplicated > 0 THEN
        RAISE EXCEPTION
            'books tem % external_id duplicado(s); unifique antes de aplicar esta migration',
            duplicated;
    END IF;
END $$;

ALTER TABLE public.books
    ADD CONSTRAINT books_external_id_key UNIQUE (external_id);
