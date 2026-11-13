-- Pedidos de participação num encontro (CLU-343/CLU-344).
--
-- Tabela própria em vez de status em meeting_users: os consumidores de
-- meeting_users (lembretes, presença, painel) tratam qualquer linha de quem não
-- é do grupo como convidada. Pedido pendente ou recusado não pode aparecer
-- ali. Quando o pedido é aceito, a convidada é gravada em meeting_users com
-- invitation_status = CONFIRMED, o modelo de convidada que já existe.
--
-- UNIQUE (meeting_id, user_id): pedir de novo depois de recusada reaproveita a
-- linha. CASCADE no encontro e na leitora: o pedido só existe junto deles.
--
-- Quem decide: a anfitriã do encontro (meetings.host_id aponta para
-- group_users.id) ou uma coordenadora do grupo, sempre com vínculo ACTIVE e
-- conta ativa.
--
-- Erros (lidos pelas edge functions):
--   MG001 encontro inexistente ou de grupo inativo
--   MG002 encontro não está aberto a pedidos (não SCHEDULED ou já passou)
--   MG003 encontro de outra cidade
--   MG004 leitora já tem vínculo (ou pedido de entrada) com o grupo
--   MG011 pedido recusado há menos de 24 h
--   MG005 já pediu, já foi aceita ou já está no encontro
--   MG006 pedido inexistente ou quem revisa não decide por este encontro
--   MG007 conta da leitora inativa
--   MG008 encontro sem anfitriã nem coordenadora ativa para decidir
--   MG009 pedido já respondido
--   MG010 pedido não vale mais (encontro fechou, conta inativada ou virou membro)
--
-- Só a service_role executa as funções; as edge functions resolvem a leitora
-- pelo token.

CREATE TABLE IF NOT EXISTS public.meeting_guest_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status public.meeting_guest_request_status NOT NULL DEFAULT 'REQUESTED',
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CONSTRAINT meeting_guest_requests_pkey PRIMARY KEY (id),
  CONSTRAINT meeting_guest_requests_meeting_id_fkey
    FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE,
  CONSTRAINT meeting_guest_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT meeting_guest_requests_meeting_id_user_id_key
    UNIQUE (meeting_id, user_id)
);

ALTER TABLE public.meeting_guest_requests ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meeting_guest_requests
TO service_role;

-- Ids (public.users) de quem decide os pedidos daquele encontro.
CREATE OR REPLACE FUNCTION public.meeting_guest_reviewer_ids(
  p_meeting_id uuid
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(array_agg(DISTINCT gu.user_id), '{}')
  FROM public.meetings m
  JOIN public.group_users gu ON gu.group_id = m.group_id
  JOIN public.users u ON u.id = gu.user_id
  WHERE m.id = p_meeting_id
    AND gu.registration_status = 'ACTIVE'
    AND u.is_active
    AND (gu.is_coordinator OR gu.id = m.host_id);
$$;

CREATE OR REPLACE FUNCTION public.request_meeting_participation(
  p_user_id uuid,
  p_meeting_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_meeting public.meetings;
  v_group public.groups;
  v_user public.users;
  v_request public.meeting_guest_requests;
  v_reviewer_ids uuid[];
BEGIN
  SELECT * INTO v_meeting
  FROM public.meetings
  WHERE id = p_meeting_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'MG001', MESSAGE = 'meeting not found';
  END IF;

  SELECT * INTO v_group FROM public.groups WHERE id = v_meeting.group_id;
  IF NOT v_group.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'MG001', MESSAGE = 'meeting not found';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND OR NOT v_user.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'MG007', MESSAGE = 'inactive account';
  END IF;

  IF v_user.city_id <> v_group.city_id THEN
    RAISE EXCEPTION USING ERRCODE = 'MG003', MESSAGE = 'meeting not available';
  END IF;

  IF v_meeting.status <> 'SCHEDULED' OR v_meeting.date IS NULL
    OR v_meeting.date <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'MG002', MESSAGE = 'meeting not open';
  END IF;

  -- Qualquer vínculo bloqueia (não só ACTIVE): os lembretes só tratam como
  -- convidada quem não tem linha nenhuma em group_users do grupo.
  IF EXISTS (
    SELECT 1 FROM public.group_users
    WHERE group_id = v_meeting.group_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'MG004', MESSAGE = 'already a member';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.meeting_users
    WHERE meeting_id = p_meeting_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'MG005', MESSAGE = 'already requested';
  END IF;

  v_reviewer_ids := public.meeting_guest_reviewer_ids(p_meeting_id);
  IF cardinality(v_reviewer_ids) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'MG008', MESSAGE = 'meeting has no reviewer';
  END IF;

  SELECT * INTO v_request
  FROM public.meeting_guest_requests
  WHERE meeting_id = p_meeting_id AND user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_request.status <> 'REJECTED' THEN
      RAISE EXCEPTION USING ERRCODE = 'MG005', MESSAGE = 'already requested';
    END IF;

    -- Evita que pedidos repetidos virem uma enxurrada de avisos.
    IF v_request.reviewed_at > now() - interval '1 day' THEN
      RAISE EXCEPTION USING ERRCODE = 'MG011', MESSAGE = 'recently rejected';
    END IF;

    UPDATE public.meeting_guest_requests
    SET status = 'REQUESTED', requested_at = now(), reviewed_at = NULL
    WHERE id = v_request.id
    RETURNING * INTO v_request;
  ELSE
    BEGIN
      INSERT INTO public.meeting_guest_requests (meeting_id, user_id)
      VALUES (p_meeting_id, p_user_id)
      RETURNING * INTO v_request;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = 'MG005', MESSAGE = 'already requested';
    END;
  END IF;

  PERFORM public.create_notification(
    'MEETING_GUEST_REQUESTED',
    'Novo pedido de participação',
    format(
      '%s pediu para participar do encontro do Grupo %s em %s.',
      v_user.name,
      v_group.number,
      to_char(v_meeting.date AT TIME ZONE 'America/Sao_Paulo', 'DD/MM')
    ),
    v_reviewer_ids,
    p_meeting_id,
    v_meeting.group_id,
    NULL,
    format(
      'MEETING_GUEST_REQUESTED:%s:%s',
      v_request.id,
      extract(epoch FROM v_request.requested_at)
    )
  );

  RETURN v_request.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_meeting_guest_request(
  p_request_id uuid,
  p_reviewer_user_id uuid,
  p_approve boolean
)
RETURNS public.meeting_guest_request_status
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_request public.meeting_guest_requests;
  v_meeting public.meetings;
  v_group_number integer;
  v_type public.notification_type;
BEGIN
  SELECT * INTO v_request
  FROM public.meeting_guest_requests
  WHERE id = p_request_id
  FOR UPDATE;

  -- Mesmo erro para pedido inexistente e para quem não decide por ele, para
  -- não revelar pedidos de outros encontros.
  IF NOT FOUND OR NOT (
    p_reviewer_user_id = ANY (public.meeting_guest_reviewer_ids(v_request.meeting_id))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'MG006', MESSAGE = 'request not found';
  END IF;

  IF v_request.status <> 'REQUESTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'MG009', MESSAGE = 'request already reviewed';
  END IF;

  SELECT * INTO v_meeting
  FROM public.meetings
  WHERE id = v_request.meeting_id
  FOR SHARE;

  IF p_approve AND (
    v_meeting.status <> 'SCHEDULED'
    OR NOT EXISTS (
      SELECT 1 FROM public.groups
      WHERE id = v_meeting.group_id AND is_active
    )
    OR v_meeting.date IS NULL
    OR v_meeting.date <= now()
    OR NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = v_request.user_id AND is_active
    )
    OR EXISTS (
      SELECT 1 FROM public.group_users
      WHERE group_id = v_meeting.group_id AND user_id = v_request.user_id
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'MG010', MESSAGE = 'request no longer valid';
  END IF;

  IF p_approve THEN
    INSERT INTO public.meeting_users (meeting_id, user_id, invitation_status)
    VALUES (v_request.meeting_id, v_request.user_id, 'CONFIRMED')
    ON CONFLICT (meeting_id, user_id)
    DO UPDATE SET invitation_status = 'CONFIRMED';
  END IF;

  UPDATE public.meeting_guest_requests
  SET status = CASE WHEN p_approve THEN 'ACCEPTED' ELSE 'REJECTED' END::public.meeting_guest_request_status,
      reviewed_at = now()
  WHERE id = v_request.id
  RETURNING * INTO v_request;

  SELECT number INTO v_group_number
  FROM public.groups
  WHERE id = v_meeting.group_id;

  v_type := CASE WHEN p_approve THEN 'MEETING_GUEST_APPROVED' ELSE 'MEETING_GUEST_REJECTED' END::public.notification_type;

  PERFORM public.create_notification(
    v_type,
    CASE WHEN p_approve THEN 'Participação confirmada' ELSE 'Pedido de participação recusado' END,
    CASE
      WHEN p_approve THEN format(
        'Você vai participar do encontro do Grupo %s em %s.',
        v_group_number,
        to_char(v_meeting.date AT TIME ZONE 'America/Sao_Paulo', 'DD/MM')
      )
      ELSE format(
        'Seu pedido para participar do encontro do Grupo %s foi recusado.',
        v_group_number
      )
    END,
    ARRAY[v_request.user_id],
    v_request.meeting_id,
    v_meeting.group_id,
    NULL,
    format(
      '%s:%s:%s',
      v_type,
      v_request.id,
      extract(epoch FROM v_request.requested_at)
    )
  );

  RETURN v_request.status;
END;
$$;

REVOKE ALL ON FUNCTION public.meeting_guest_reviewer_ids(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meeting_guest_reviewer_ids(uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.request_meeting_participation(uuid, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_meeting_participation(uuid, uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.review_meeting_guest_request(uuid, uuid, boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_meeting_guest_request(uuid, uuid, boolean)
TO service_role;
