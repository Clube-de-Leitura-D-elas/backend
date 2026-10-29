-- Sorteio do encontro (CLU-48): registra a leitora e o livro sorteados.
--
-- A sorteada é a anfitriã temporária do próximo encontro, e o livro da
-- indicação dela é a próxima leitura. Um sorteio por encontro.
--
-- RLS: como o resto do schema, a tabela é acessada só pelas edge functions
-- com service role. `record_meeting_raffle` também só roda pela service role.

CREATE TABLE public.meeting_raffles (
  meeting_id uuid NOT NULL,
  winner_user_id uuid NOT NULL,
  book_suggestion_id uuid NOT NULL,
  book_id uuid NOT NULL,
  drawn_by uuid NOT NULL,
  drawn_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT meeting_raffles_pkey PRIMARY KEY (meeting_id),
  CONSTRAINT meeting_raffles_book_suggestion_id_key UNIQUE (book_suggestion_id),
  CONSTRAINT meeting_raffles_meeting_id_fkey
    FOREIGN KEY (meeting_id) REFERENCES public.meetings(id),
  CONSTRAINT meeting_raffles_winner_user_id_fkey
    FOREIGN KEY (winner_user_id) REFERENCES public.users(id),
  CONSTRAINT meeting_raffles_book_suggestion_id_fkey
    FOREIGN KEY (book_suggestion_id) REFERENCES public.book_suggestions(id),
  CONSTRAINT meeting_raffles_book_id_fkey
    FOREIGN KEY (book_id) REFERENCES public.books(id),
  CONSTRAINT meeting_raffles_drawn_by_fkey
    FOREIGN KEY (drawn_by) REFERENCES public.users(id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.meeting_raffles
TO service_role;

-- Grava o resultado e tira o livro da concorrência numa transação só.
-- A trava por grupo serializa sorteios simultâneos de encontros do mesmo
-- grupo, para o mesmo livro não sair duas vezes.
-- P0048: a indicação deixou de estar disponível (já sorteada).
-- P0049: o livro já foi sorteado ou lido no grupo.
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

  UPDATE public.book_suggestions
  SET book_status = 'DRAWN'
  WHERE id = p_book_suggestion_id
    AND book_id = p_book_id
    AND book_status = 'AVAILABLE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'book suggestion is no longer available'
      USING ERRCODE = 'P0048';
  END IF;

  INSERT INTO public.meeting_raffles
    (meeting_id, winner_user_id, book_suggestion_id, book_id, drawn_by)
  VALUES
    (p_meeting_id, p_winner_user_id, p_book_suggestion_id, p_book_id, p_drawn_by)
  RETURNING * INTO new_raffle;

  RETURN new_raffle;
END;
$$;

REVOKE ALL ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_meeting_raffle(uuid, uuid, uuid, uuid, uuid)
TO service_role;
