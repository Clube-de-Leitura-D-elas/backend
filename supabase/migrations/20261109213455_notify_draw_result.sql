-- Aviso do resultado do sorteio (CLU-299): o primeiro aviso de ponta a ponta
-- do épico de notificações e o exemplo citado no README em "Como criar um
-- novo aviso".
--
-- record_meeting_raffle passa a chamar create_notification depois de criar o
-- próximo encontro, na mesma transação: se o aviso falhar, o sorteio também
-- não é gravado. A função é recriada aqui com CREATE OR REPLACE porque a
-- migration que a criou já foi aplicada; fora o aviso, o corpo não muda.
--
-- Destinatárias: todas as participantes ativas do grupo (vínculo ACTIVE e
-- conta ativa), inclusive a sorteada. O aviso aponta para o próximo encontro,
-- então tocar nele abre o rascunho que a anfitriã vai preencher.
--
-- meeting_raffles não tem id próprio: um sorteio é identificado pelo
-- meeting_id do encontro sorteado (a chave primária), e é ele que entra na
-- dedup_key.

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
  v_book_name text;
  v_winner_name text;
  v_group_number integer;
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
    p_dedup_key => 'DRAW_RESULT:' || p_meeting_id
  );

  RETURN new_raffle;
END;
$$;

REVOKE ALL ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
TO service_role;
