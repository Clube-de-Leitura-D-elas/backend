-- Coordenadora aprova ou recusa um pedido de entrada no grupo (CLU-330). A
-- mudança de status e o aviso à leitora acontecem na mesma transação.
--
-- Quem revisa precisa ser coordenadora ativa do grupo do pedido (vínculo
-- ACTIVE e conta ativa). A linha do pedido fica bloqueada para dois cliques (ou
-- duas coordenadoras) não decidirem o mesmo pedido; a da coordenadora, para ela
-- não ser rebaixada no meio.
--
-- Aprovar reconfere o que request_group_join validou (grupo e conta da leitora
-- ativos), porque os dois podem ter sido inativados depois do pedido. Recusar
-- continua possível. Na aprovação, created_at (data de entrada no grupo) passa
-- a ser a data da aprovação.
--
-- Erros (lidos pela edge function review-group-join-request):
--   GJ004 pedido inexistente ou quem revisa não é coordenadora do grupo dele
--         (mesmo erro, para não revelar pedido de outro grupo)
--   GJ006 pedido já não está aguardando (REQUESTED)
--   GJ009 grupo ou conta da leitora inativados depois do pedido
--
-- Só a service_role executa; a edge function resolve a coordenadora pelo token.

CREATE OR REPLACE FUNCTION public.review_group_join_request(
  p_group_user_id uuid,
  p_reviewer_user_id uuid,
  p_approve boolean
)
RETURNS public.registration_status
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_link public.group_users;
  v_group_number integer;
  v_type public.notification_type;
BEGIN
  SELECT * INTO v_link
  FROM public.group_users
  WHERE id = p_group_user_id
  FOR UPDATE;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.group_users gu
    JOIN public.users u ON u.id = gu.user_id
    WHERE gu.group_id = v_link.group_id
      AND gu.user_id = p_reviewer_user_id
      AND gu.is_coordinator
      AND gu.registration_status = 'ACTIVE'
      AND u.is_active
    FOR SHARE OF gu
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ004', MESSAGE = 'request not found';
  END IF;

  IF v_link.registration_status <> 'REQUESTED' THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ006', MESSAGE = 'request already reviewed';
  END IF;

  IF p_approve AND NOT EXISTS (
    SELECT 1
    FROM public.groups g, public.users u
    WHERE g.id = v_link.group_id
      AND g.is_active
      AND u.id = v_link.user_id
      AND u.is_active
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'GJ009', MESSAGE = 'request no longer valid';
  END IF;

  UPDATE public.group_users
  SET registration_status = CASE WHEN p_approve THEN 'ACTIVE' ELSE 'REJECTED' END::public.registration_status,
      created_at = CASE WHEN p_approve THEN now() ELSE created_at END
  WHERE id = v_link.id
  RETURNING * INTO v_link;

  SELECT number INTO v_group_number FROM public.groups WHERE id = v_link.group_id;
  v_type := CASE WHEN p_approve THEN 'GROUP_JOIN_APPROVED' ELSE 'GROUP_JOIN_REJECTED' END::public.notification_type;

  PERFORM public.create_notification(
    v_type,
    CASE WHEN p_approve THEN 'Pedido aprovado' ELSE 'Pedido recusado' END,
    CASE
      WHEN p_approve THEN format('Você agora faz parte do Grupo %s.', v_group_number)
      ELSE format('Seu pedido para entrar no Grupo %s foi recusado.', v_group_number)
    END,
    ARRAY[v_link.user_id],
    NULL,
    v_link.group_id,
    NULL,
    format(
      '%s:%s:%s',
      v_type,
      v_link.id,
      extract(epoch FROM v_link.requested_at)
    )
  );

  RETURN v_link.registration_status;
END;
$$;

REVOKE ALL ON FUNCTION public.review_group_join_request(uuid, uuid, boolean)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_group_join_request(uuid, uuid, boolean)
TO service_role;
