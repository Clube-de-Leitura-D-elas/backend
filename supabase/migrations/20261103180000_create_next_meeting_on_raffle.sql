-- Cria o rascunho do próximo encontro (status = 'CREATED') ao confirmar o
-- sorteio (CLU-48).
--
-- A sorteada já nasce como anfitriã (host_id = group_users.id do vínculo dela)
-- e o livro sorteado como leitura do encontro, sem data nem local definidos
-- para ela preencher nas tarefas da anfitriã.
--
-- Dados existentes: `next_meeting_id` entra nullable, aponta para o encontro já
-- existente do mesmo livro no grupo (se houver) ou cria o rascunho faltante, e
-- só então recebe NOT NULL + UNIQUE + FK.

ALTER TABLE public.meeting_raffles
  ADD COLUMN next_meeting_id uuid;

DO $$
DECLARE
  r RECORD;
  v_next_meeting_id uuid;
BEGIN
  FOR r IN
    SELECT mr.meeting_id AS raffled_meeting_id,
           m.group_id,
           bs.group_user_id AS host_id,
           mr.book_id
    FROM public.meeting_raffles mr
    JOIN public.meetings m ON m.id = mr.meeting_id
    JOIN public.book_suggestions bs ON bs.id = mr.book_suggestion_id
    WHERE mr.next_meeting_id IS NULL
    ORDER BY mr.drawn_at, mr.meeting_id
  LOOP
    SELECT existing.id INTO v_next_meeting_id
    FROM public.meetings existing
    WHERE existing.group_id = r.group_id
      AND existing.book_id = r.book_id
      AND existing.id <> r.raffled_meeting_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.meeting_raffles other
        WHERE other.next_meeting_id = existing.id
      )
    ORDER BY existing.date NULLS FIRST, existing.id
    LIMIT 1;

    IF v_next_meeting_id IS NULL THEN
      INSERT INTO public.meetings (group_id, host_id, book_id, status)
      VALUES (r.group_id, r.host_id, r.book_id, 'CREATED')
      RETURNING id INTO v_next_meeting_id;
    END IF;

    UPDATE public.meeting_raffles
    SET next_meeting_id = v_next_meeting_id
    WHERE meeting_id = r.raffled_meeting_id;
  END LOOP;
END;
$$;

ALTER TABLE public.meeting_raffles
  ALTER COLUMN next_meeting_id SET NOT NULL,
  ADD CONSTRAINT meeting_raffles_next_meeting_id_key UNIQUE (next_meeting_id),
  ADD CONSTRAINT meeting_raffles_next_meeting_id_fkey
    FOREIGN KEY (next_meeting_id) REFERENCES public.meetings(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.record_meeting_raffle(
  p_meeting_id uuid,
  p_winner_user_id uuid,
  p_book_suggestion_id uuid,
  p_book_id uuid,
  p_drawn_by uuid
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
BEGIN
  SELECT group_id INTO v_group_id
  FROM public.meetings
  WHERE id = p_meeting_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'meeting not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('meeting_raffles:' || v_group_id::text));

  IF EXISTS (
    SELECT 1
    FROM public.meeting_raffles
    WHERE meeting_id = p_meeting_id
  ) THEN
    RAISE EXCEPTION 'raffle already recorded for this meeting'
      USING ERRCODE = '23505';
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
    meeting_id,
    winner_user_id,
    book_suggestion_id,
    book_id,
    drawn_by,
    next_meeting_id
  )
  VALUES (
    p_meeting_id,
    p_winner_user_id,
    p_book_suggestion_id,
    p_book_id,
    p_drawn_by,
    v_next_meeting_id
  )
  RETURNING * INTO new_raffle;

  RETURN new_raffle;
END;
$$;

REVOKE ALL ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
TO service_role;

