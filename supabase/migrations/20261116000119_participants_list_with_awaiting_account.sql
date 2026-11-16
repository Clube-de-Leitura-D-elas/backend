-- Lista de participantes do painel web (CLU-284, edge function `get-participants`).
-- Inclui quem já foi aprovada (`pending_users.is_approved`) mas ainda não usou o convite
-- (`token_used_at` nulo): essas pessoas saem da aba Solicitações e só entram em `users` no
-- claim, então antes ficavam invisíveis no painel. Elas aparecem com status
-- `awaiting_account`.
-- Juntar as duas tabelas na mesma paginação exige o UNION aqui, não no supabase-js.
-- A cidade da solicitação é texto livre: o filtro compara pelo nome, como o claim faz ao
-- resolver a cidade. Quem aguarda conta não tem grupo, então some com o filtro de grupo.
-- Pedido de entrada (REQUESTED) e recusado (REJECTED) não são vínculo com o grupo: ficam fora
-- da contagem e do filtro de grupo, como `NOT_JOINED_FILTER` em `_shared/group.ts`.
-- Só cria a função: não altera tabelas nem dados. Execução só pela service role.

CREATE OR REPLACE FUNCTION public.list_participants_web(
  p_search text,
  p_city_id uuid,
  p_group_id uuid,
  p_order_column text,
  p_ascending boolean,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_order_column IS NULL OR p_order_column NOT IN ('name', 'created_at') THEN
    RAISE EXCEPTION 'invalid order column: %', p_order_column;
  END IF;

  WITH participants AS (
    SELECT
      u.id,
      u.name::text AS name,
      u.created_at,
      u.is_active,
      CASE WHEN u.is_active THEN 'active' ELSE 'inactive' END AS status,
      coalesce(
        (SELECT array_agg(gu.id ORDER BY gu.id)
         FROM public.group_users gu
         WHERE gu.user_id = u.id
           AND gu.registration_status::text NOT IN ('REQUESTED', 'REJECTED')),
        '{}'::uuid[]
      ) AS group_user_ids
    FROM public.users u
    WHERE (p_city_id IS NULL OR u.city_id = p_city_id)
      AND (p_group_id IS NULL OR EXISTS (
        SELECT 1 FROM public.group_users gu
        WHERE gu.user_id = u.id
          AND gu.group_id = p_group_id
          AND gu.registration_status::text NOT IN ('REQUESTED', 'REJECTED')
      ))
    UNION ALL
    SELECT
      pu.id,
      pu.name::text,
      pu.created_at,
      false,
      'awaiting_account',
      '{}'::uuid[]
    FROM public.pending_users pu
    WHERE pu.is_approved
      AND pu.token_used_at IS NULL
      AND p_group_id IS NULL
      AND (p_city_id IS NULL OR EXISTS (
        SELECT 1 FROM public.cities c
        WHERE c.id = p_city_id AND lower(c.name) = lower(pu.city)
      ))
  ),
  filtered AS (
    SELECT * FROM participants p
    WHERE coalesce(p_search, '') = '' OR p.name ILIKE '%' || p_search || '%'
  ),
  page AS (
    SELECT * FROM filtered f
    ORDER BY
      CASE WHEN p_order_column = 'name' AND p_ascending THEN f.name END ASC,
      CASE WHEN p_order_column = 'name' AND NOT p_ascending THEN f.name END DESC,
      CASE WHEN p_order_column = 'created_at' AND p_ascending THEN f.created_at END ASC,
      CASE WHEN p_order_column = 'created_at' AND NOT p_ascending THEN f.created_at END DESC,
      f.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'items', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'id', pg.id,
           'name', pg.name,
           'is_active', pg.is_active,
           'status', pg.status,
           'group_user_ids', to_jsonb(pg.group_user_ids)
         )
         ORDER BY
           CASE WHEN p_order_column = 'name' AND p_ascending THEN pg.name END ASC,
           CASE WHEN p_order_column = 'name' AND NOT p_ascending THEN pg.name END DESC,
           CASE WHEN p_order_column = 'created_at' AND p_ascending THEN pg.created_at END ASC,
           CASE WHEN p_order_column = 'created_at' AND NOT p_ascending THEN pg.created_at END DESC,
           pg.id
       ) FROM page pg),
      '[]'::jsonb
    ),
    'total', (SELECT count(*) FROM filtered)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.list_participants_web(text, uuid, uuid, text, boolean, integer, integer)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.list_participants_web(text, uuid, uuid, text, boolean, integer, integer)
TO service_role;
