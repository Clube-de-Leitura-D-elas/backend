-- Regra de indicação de livros por leitora e elegibilidade de anfitriã:
-- 1. Cada leitora pode manter apenas uma indicação ativa (book_status = 'AVAILABLE')
--    por grupo; ao indicar outro livro no mesmo grupo enquanto elegível, a
--    indicação ativa anterior é substituída diretamente.
-- 2. Duas leitoras não podem indicar o mesmo livro no mesmo grupo: permanece
--    a constraint book_suggestions_group_id_book_id_key UNIQUE (group_id, book_id)
--    e também bloqueamos livros já presentes em encontros do grupo.
-- 3. Leitoras que já são anfitriãs de encontro aberto no grupo ou que estão
--    bloqueadas pelo rodízio de anfitriãs não podem indicar livros nesse grupo
--    até que todas as outras integrantes ativas sejam anfitriãs depois delas.

-- Limpa eventuais indicações AVAILABLE duplicadas da mesma participante no
-- mesmo grupo antes de criar o índice único parcial. Mantém a mais relevante:
-- livro ainda não usado em encontros do grupo e, em caso de empate, a mais recente.
DELETE FROM public.book_suggestions bs
USING (
  SELECT bs2.id,
         row_number() OVER (
           PARTITION BY bs2.group_id, bs2.group_user_id
           ORDER BY
             EXISTS (
               SELECT 1
               FROM public.meetings m
               WHERE m.group_id = bs2.group_id
                 AND m.book_id = bs2.book_id
             ) ASC,
             bs2.suggested_at DESC,
             bs2.id DESC
         ) AS position
  FROM public.book_suggestions bs2
  WHERE bs2.book_status = 'AVAILABLE'
) ranked
WHERE bs.id = ranked.id
  AND ranked.position > 1
  AND NOT EXISTS (
    SELECT 1
    FROM public.meeting_raffles mr
    WHERE mr.book_suggestion_id = bs.id
  );

CREATE UNIQUE INDEX book_suggestions_one_available_per_member_idx
  ON public.book_suggestions (group_id, group_user_id)
  WHERE book_status = 'AVAILABLE';

-- Retorna true se a leitora estiver impedida de indicar livros no grupo por
-- já ser anfitriã/sorteada de um encontro aberto ou por estar aguardando as
-- demais integrantes ativas no rodízio de anfitriãs.
CREATE OR REPLACE FUNCTION public.is_reader_host_blocked(
  p_group_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_user_last_hosted timestamp with time zone;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.meetings m
    JOIN public.group_users gu ON gu.id = m.host_id
    WHERE m.group_id = p_group_id
      AND gu.user_id = p_user_id
      AND m.status IN ('CREATED', 'SCHEDULED', 'IN_PROGRESS')
  ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.meeting_raffles mr
    JOIN public.meetings m ON m.id = mr.next_meeting_id
    WHERE mr.group_id = p_group_id
      AND mr.winner_user_id = p_user_id
      AND m.status IN ('CREATED', 'SCHEDULED', 'IN_PROGRESS')
  ) THEN
    RETURN true;
  END IF;

  SELECT MAX(COALESCE(m.date, '1970-01-01T00:00:00Z'::timestamp with time zone))
  INTO v_user_last_hosted
  FROM public.meetings m
  JOIN public.group_users gu ON gu.id = m.host_id
  WHERE m.group_id = p_group_id
    AND gu.user_id = p_user_id
    AND m.status IN ('ENDED', 'CONCLUDED');

  IF v_user_last_hosted IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.group_users gu
    JOIN public.users u ON u.id = gu.user_id
    WHERE gu.group_id = p_group_id
      AND gu.registration_status = 'ACTIVE'
      AND u.is_active = true
      AND gu.user_id <> p_user_id
      AND COALESCE(
        (
          SELECT MAX(
            CASE
              WHEN m.status IN ('CREATED', 'SCHEDULED', 'IN_PROGRESS')
                THEN 'infinity'::timestamp with time zone
              ELSE COALESCE(m.date, '1970-01-01T00:00:00Z'::timestamp with time zone)
            END
          )
          FROM public.meetings m
          JOIN public.group_users host_gu ON host_gu.id = m.host_id
          WHERE m.group_id = p_group_id
            AND host_gu.user_id = gu.user_id
            AND m.status IN ('CREATED', 'SCHEDULED', 'IN_PROGRESS', 'ENDED', 'CONCLUDED')
        ),
        '-infinity'::timestamp with time zone
      ) < v_user_last_hosted
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_host_blocked_group_ids(
  p_user_id uuid,
  p_group_ids uuid[]
)
RETURNS TABLE (group_id uuid)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT gid AS group_id
  FROM unnest(p_group_ids) AS gid
  WHERE public.is_reader_host_blocked(gid, p_user_id);
$$;

-- Cria ou substitui de forma atômica a indicação ativa da leitora no grupo.
-- Códigos de erro esperados pela Edge Function recommend-book:
--   P0043: not_group_member
--   P0052: host_not_eligible
--   P0002: book_not_found
--   23505: already_recommended
CREATE OR REPLACE FUNCTION public.recommend_book(
  p_group_id uuid,
  p_user_id uuid,
  p_book_id uuid
)
RETURNS TABLE (
  id uuid,
  book_id uuid,
  group_id uuid,
  suggested_at timestamp with time zone,
  action text
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_group_user_id uuid;
  v_existing_id uuid;
  v_id uuid;
  v_book_id uuid;
  v_group_id uuid;
  v_suggested_at timestamp with time zone;
  v_action text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('group_recommendations:' || p_group_id::text)
  );

  SELECT gu.id
  INTO v_group_user_id
  FROM public.group_users gu
  JOIN public.groups g ON g.id = gu.group_id
  WHERE gu.group_id = p_group_id
    AND gu.user_id = p_user_id
    AND gu.registration_status = 'ACTIVE'
    AND g.is_active = true
  LIMIT 1;

  IF v_group_user_id IS NULL THEN
    RAISE EXCEPTION 'not_group_member'
      USING ERRCODE = 'P0043';
  END IF;

  IF public.is_reader_host_blocked(p_group_id, p_user_id) THEN
    RAISE EXCEPTION 'host_not_eligible'
      USING ERRCODE = 'P0052';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.books b
    WHERE b.id = p_book_id
  ) THEN
    RAISE EXCEPTION 'book_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.book_suggestions bs
    WHERE bs.group_id = p_group_id
      AND bs.book_id = p_book_id
  ) OR EXISTS (
    SELECT 1
    FROM public.meetings m
    WHERE m.group_id = p_group_id
      AND m.book_id = p_book_id
  ) THEN
    RAISE EXCEPTION 'already_recommended'
      USING ERRCODE = '23505';
  END IF;

  SELECT bs.id
  INTO v_existing_id
  FROM public.book_suggestions bs
  WHERE bs.group_id = p_group_id
    AND bs.group_user_id = v_group_user_id
    AND bs.book_status = 'AVAILABLE'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.book_suggestions AS bs
    SET book_id = p_book_id,
        suggested_at = now()
    WHERE bs.id = v_existing_id
    RETURNING bs.id, bs.book_id, bs.group_id, bs.suggested_at
    INTO v_id, v_book_id, v_group_id, v_suggested_at;

    v_action := 'replaced';
  ELSE
    INSERT INTO public.book_suggestions AS bs (
      book_id,
      group_id,
      group_user_id,
      suggested_at,
      book_status
    )
    VALUES (
      p_book_id,
      p_group_id,
      v_group_user_id,
      now(),
      'AVAILABLE'
    )
    RETURNING bs.id, bs.book_id, bs.group_id, bs.suggested_at
    INTO v_id, v_book_id, v_group_id, v_suggested_at;

    v_action := 'created';
  END IF;

  RETURN QUERY
  SELECT v_id, v_book_id, v_group_id, v_suggested_at, v_action;
END;
$$;

REVOKE ALL ON FUNCTION public.is_reader_host_blocked(uuid, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_reader_host_blocked(uuid, uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.get_host_blocked_group_ids(uuid, uuid[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_host_blocked_group_ids(uuid, uuid[])
TO service_role;

REVOKE ALL ON FUNCTION public.recommend_book(uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recommend_book(uuid, uuid, uuid)
TO service_role;
