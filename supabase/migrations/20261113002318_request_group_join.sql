-- Pedido de entrada em grupo pelo app (CLU-329). Grava o pedido em
-- group_users e avisa as coordenadoras na mesma transação, para não existir
-- pedido sem aviso nem aviso sem pedido.
--
-- Transições aceitas: sem vínculo -> REQUESTED; REJECTED -> REQUESTED (pedir de
-- novo); INACTIVE -> REQUESTED (ex-participante voltando, reaproveita a linha
-- por causa do UNIQUE (group_id, user_id)). ACTIVE, PENDING e REQUESTED são
-- conflito. A linha volta sempre com is_coordinator = false.
--
-- Coordenadora "ativa" é vínculo ACTIVE e conta ativa (users.is_active), como
-- em notify_schedule_pending. Sem nenhuma, o pedido ficaria sem quem decida.
--
-- Erros (lidos pela edge function request-group-join):
--   GJ001 grupo inexistente ou inativo
--   GJ002 grupo de outra cidade
--   GJ003 já é membro, já pediu ou aguarda criação de conta
--   GJ007 conta da leitora inativa
--   GJ008 grupo sem coordenadora ativa
--
-- Só a service_role executa; a edge function resolve a leitora pelo token.

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

  IF v_user.city_id <> v_group.city_id THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ002', MESSAGE = 'group not available';
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

REVOKE ALL ON FUNCTION public.request_group_join(uuid, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.request_group_join(uuid, uuid)
TO service_role;
