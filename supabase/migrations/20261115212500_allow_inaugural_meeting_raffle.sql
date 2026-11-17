-- Sorteio inaugural e sorteio quando o grupo não tem encontro aberto (CLU-339).
--
-- Generaliza a tabela meeting_raffles para suportar sorteios sem encontro de
-- origem (sorteio inaugural de grupo recém-criado):
-- 1. Adiciona coluna id como primary key própria e group_id referenciando groups.
-- 2. Torna meeting_id nullable (sorteio inaugural não tem encontro de origem).
-- 3. Adiciona travas de unicidade: no máximo um sorteio por encontro e no máximo
--    um sorteio inaugural por grupo.
-- 4. Atualiza record_meeting_raffle para receber p_group_id opcional e garantir
--    atomicamente que nenhum sorteio seja realizado caso o grupo já possua um
--    encontro aberto (CREATED, SCHEDULED, IN_PROGRESS).

ALTER TABLE public.meeting_raffles
  ADD COLUMN id uuid DEFAULT gen_random_uuid(),
  ADD COLUMN group_id uuid
    REFERENCES public.groups(id) ON DELETE RESTRICT;

UPDATE public.meeting_raffles mr
SET group_id = m.group_id
FROM public.meetings m
WHERE mr.meeting_id = m.id
  AND mr.group_id IS NULL;

ALTER TABLE public.meeting_raffles
  ALTER COLUMN group_id SET NOT NULL,
  DROP CONSTRAINT meeting_raffles_pkey,
  DROP CONSTRAINT meeting_raffles_meeting_id_fkey,
  ADD CONSTRAINT meeting_raffles_pkey PRIMARY KEY (id),
  ADD CONSTRAINT meeting_raffles_meeting_group_id_fkey
    FOREIGN KEY (meeting_id, group_id)
    REFERENCES public.meetings(id, group_id) ON DELETE RESTRICT,
  ALTER COLUMN meeting_id DROP NOT NULL;

CREATE UNIQUE INDEX meeting_raffles_origin_meeting_unique
  ON public.meeting_raffles(meeting_id)
  WHERE meeting_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_raffles_inaugural_unique
  ON public.meeting_raffles(group_id)
  WHERE meeting_id IS NULL;

DROP FUNCTION IF EXISTS public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.record_meeting_raffle(
  p_meeting_id uuid,
  p_winner_user_id uuid,
  p_book_suggestion_id uuid,
  p_book_id uuid,
  p_drawn_by uuid,
  p_group_id uuid DEFAULT NULL
)
RETURNS public.meeting_raffles
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_raffle public.meeting_raffles;
  v_group_id uuid;
  v_host_id uuid;
  v_next_meeting_id uuid;
  v_book_name text;
  v_winner_name text;
  v_group_number integer;
BEGIN
  IF p_meeting_id IS NOT NULL THEN
    SELECT group_id INTO v_group_id
    FROM public.meetings
    WHERE id = p_meeting_id;

    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'meeting not found'
        USING ERRCODE = 'P0002';
    END IF;
  ELSE
    IF p_group_id IS NULL THEN
      RAISE EXCEPTION 'group_id is required when meeting_id is null'
        USING ERRCODE = 'P0002';
    END IF;

    SELECT id INTO v_group_id
    FROM public.groups
    WHERE id = p_group_id;

    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'group not found'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('group_meetings:' || v_group_id::text));

  -- Concorrência / Encontro aberto: impede novo encontro se já houver algum aberto no grupo
  IF EXISTS (
    SELECT 1
    FROM public.meetings
    WHERE group_id = v_group_id
      AND status IN ('CREATED', 'SCHEDULED', 'IN_PROGRESS')
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'group already has an open meeting'
      USING ERRCODE = 'P0050';
  END IF;

  IF p_meeting_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.meeting_raffles
      WHERE meeting_id = p_meeting_id
    ) THEN
      RAISE EXCEPTION 'raffle already recorded for this meeting'
        USING ERRCODE = '23505';
    END IF;
  ELSE
    -- Sorteio inaugural: não pode já ter sido sorteado nem ter encontros prévios
    IF EXISTS (
      SELECT 1
      FROM public.meeting_raffles
      WHERE group_id = v_group_id
        AND meeting_id IS NULL
    ) THEN
      RAISE EXCEPTION 'inaugural raffle already recorded for this group'
        USING ERRCODE = '23505';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.meetings
      WHERE group_id = v_group_id
    ) THEN
      RAISE EXCEPTION 'cannot perform inaugural raffle on a group with existing meetings'
        USING ERRCODE = 'P0051';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.book_suggestions bs
    JOIN public.group_users gu ON gu.id = bs.group_user_id
    WHERE gu.group_id = v_group_id
      AND bs.book_id = p_book_id
      AND bs.book_status <> 'AVAILABLE'
  ) OR EXISTS (
    SELECT 1
    FROM public.meetings
    WHERE group_id = v_group_id
      AND book_id = p_book_id
  ) THEN
    RAISE EXCEPTION 'book already drawn in this group'
      USING ERRCODE = 'P0049';
  END IF;

  UPDATE public.book_suggestions bs
  SET book_status = 'DRAWN'
  FROM public.group_users gu
  WHERE bs.id = p_book_suggestion_id
    AND bs.book_id = p_book_id
    AND bs.book_status = 'AVAILABLE'
    AND gu.id = bs.group_user_id
    AND gu.group_id = v_group_id
    AND gu.user_id = p_winner_user_id
    AND gu.registration_status = 'ACTIVE'
  RETURNING gu.id INTO v_host_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'book suggestion is no longer available'
      USING ERRCODE = 'P0048';
  END IF;

  INSERT INTO public.meetings (group_id, host_id, book_id, status)
  VALUES (v_group_id, v_host_id, p_book_id, 'CREATED')
  RETURNING id INTO v_next_meeting_id;

  INSERT INTO public.meeting_raffles (
    group_id,
    meeting_id,
    winner_user_id,
    book_suggestion_id,
    book_id,
    drawn_by,
    next_meeting_id
  )
  VALUES (
    v_group_id,
    p_meeting_id,
    p_winner_user_id,
    p_book_suggestion_id,
    p_book_id,
    p_drawn_by,
    v_next_meeting_id
  )
  RETURNING * INTO new_raffle;

  SELECT b.name INTO v_book_name
  FROM public.books b
  WHERE b.id = p_book_id;

  SELECT u.name INTO v_winner_name
  FROM public.users u
  WHERE u.id = p_winner_user_id;

  SELECT g.number INTO v_group_number
  FROM public.groups g
  WHERE g.id = v_group_id;

  PERFORM public.create_notification(
    'DRAW_RESULT',
    format('Livro sorteado: %s', v_book_name),
    format(
      '%s vai receber o próximo encontro do Grupo %s.',
      v_winner_name, v_group_number
    ),
    ARRAY(
      SELECT gu.user_id
      FROM public.group_users gu
      JOIN public.users u ON u.id = gu.user_id
      WHERE gu.group_id = v_group_id
        AND gu.registration_status = 'ACTIVE'
        AND u.is_active
    ),
    p_meeting_id => v_next_meeting_id,
    p_dedup_key => 'DRAW_RESULT:' || coalesce(p_meeting_id::text, v_group_id::text)
  );

  RETURN new_raffle;
END;
$$;

REVOKE ALL ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid, uuid)
TO service_role;
