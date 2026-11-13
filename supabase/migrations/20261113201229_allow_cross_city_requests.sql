-- Leitoras passam a ver o calendário e a busca de grupos de todas as cidades
-- (CLU-349), então pedir para entrar num grupo ou para participar de um
-- encontro de outra cidade deixa de ser recusado. As funções são recriadas
-- iguais às de 20261113002318_request_group_join.sql e
-- 20261113142249_meeting_guest_requests.sql, só sem a checagem de cidade.
-- GJ002 e MG003 deixam de existir.
--
-- CREATE OR REPLACE mantém os GRANT/REVOKE já aplicados às funções.

CREATE OR REPLACE FUNCTION public.request_group_join(
  p_user_id uuid,
  p_group_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_group public.groups;
  v_user public.users;
  v_link public.group_users;
  v_coordinator_ids uuid[];
BEGIN
  SELECT * INTO v_group
  FROM public.groups
  WHERE id = p_group_id
  FOR SHARE;

  IF NOT FOUND OR NOT v_group.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ001', MESSAGE = 'group not found';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;

  IF NOT FOUND OR NOT v_user.is_active THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ007', MESSAGE = 'inactive account';
  END IF;

  SELECT ARRAY(
    SELECT gu.user_id
    FROM public.group_users gu
    JOIN public.users u ON u.id = gu.user_id
    WHERE gu.group_id = p_group_id
      AND gu.is_coordinator
      AND gu.registration_status = 'ACTIVE'
      AND u.is_active
  ) INTO v_coordinator_ids;

  IF cardinality(v_coordinator_ids) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ008', MESSAGE = 'group has no coordinator';
  END IF;

  SELECT * INTO v_link
  FROM public.group_users
  WHERE group_id = p_group_id AND user_id = p_user_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_link.registration_status NOT IN ('REJECTED', 'INACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE = 'GJ003', MESSAGE = 'already requested';
    END IF;

    UPDATE public.group_users
    SET registration_status = 'REQUESTED',
        is_coordinator = false,
        requested_at = now()
    WHERE id = v_link.id
    RETURNING * INTO v_link;
  ELSE
    BEGIN
      INSERT INTO public.group_users
        (group_id, user_id, is_coordinator, registration_status, requested_at)
      VALUES (p_group_id, p_user_id, false, 'REQUESTED', now())
      RETURNING * INTO v_link;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = 'GJ003', MESSAGE = 'already requested';
    END;
  END IF;

  PERFORM public.create_notification(
    'GROUP_JOIN_REQUESTED',
    'Novo pedido de entrada',
    format('%s pediu para entrar no Grupo %s.', v_user.name, v_group.number),
    v_coordinator_ids,
    NULL,
    p_group_id,
    NULL,
    format(
      'GROUP_JOIN_REQUESTED:%s:%s',
      v_link.id,
      extract(epoch FROM v_link.requested_at)
    )
  );

  RETURN v_link.id;
END;
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
