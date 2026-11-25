-- Presença nos últimos 3 encontros na lista de participantes do painel web
-- (coluna "PRESENÇA (ÚLTIMOS 3)", que estava fixa em "—").
-- Cada item ganha `recent_attendance`: as três presenças registradas mais recentes da
-- participante ('PRESENT' ou 'ABSENT'), da mais antiga para a mais nova. Contam só encontros
-- encerrados (ENDED/CONCLUDED) com presença registrada; com o filtro de grupo, só os encontros
-- daquele grupo. Sem filtro, a presença como convidada em encontro de outro grupo também conta.
-- Encontro sem data fica por último (NULLS LAST) e o id desempata datas iguais. Quem aguarda
-- conta (`pending_users`) não tem encontros e recebe lista vazia.
-- A assinatura e o retorno (jsonb) não mudam, então o CREATE OR REPLACE mantém os grants; o
-- REVOKE/GRANT abaixo só reafirma o acesso exclusivo da service role. Não altera dados.

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
           'group_user_ids', to_jsonb(pg.group_user_ids),
           'recent_attendance', coalesce(
             (SELECT jsonb_agg(recent.presence ORDER BY recent.date NULLS FIRST, recent.id)
              FROM (
                SELECT mu.presence_status::text AS presence, m.date, m.id
                FROM public.meeting_users mu
                JOIN public.meetings m ON m.id = mu.meeting_id
                WHERE mu.user_id = pg.id
                  AND mu.presence_status IS NOT NULL
                  AND m.status::text IN ('ENDED', 'CONCLUDED')
                  AND (p_group_id IS NULL OR m.group_id = p_group_id)
                ORDER BY m.date DESC NULLS LAST, m.id DESC
                LIMIT 3
              ) recent),
             '[]'::jsonb
           )
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
