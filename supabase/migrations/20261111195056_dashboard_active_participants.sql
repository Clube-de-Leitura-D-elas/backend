-- Gráfico "Total de Participantes" do dashboard do painel web (CLU-251, edge
-- function `get-dashboard-active-participants-web`).
--
-- `dashboard_active_participants` devolve, para cada mês entre `p_from` e `p_to`,
-- quantas participantes ativas o clube tinha ao fim do mês. O valor é um
-- ESTOQUE (acumulado), não quantas entraram no mês.

CREATE OR REPLACE FUNCTION public.dashboard_active_participants(
  p_from date,
  p_to date
)
RETURNS TABLE (
  period date,
  total bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_first_month date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'invalid range: % to %', p_from, p_to;
  END IF;

  v_first_month := date_trunc('month', p_from::timestamp)::date;

  RETURN QUERY
  WITH active_users AS (
    SELECT (u.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS joined_on
    FROM public.users u
    WHERE u.is_active
  ),
  baseline AS (
    SELECT count(*) AS base_total
    FROM active_users au
    WHERE au.joined_on < v_first_month
  ),
  joined_by_month AS (
    SELECT
      date_trunc('month', au.joined_on::timestamp)::date AS bucket,
      count(*) AS joined_count
    FROM active_users au
    WHERE au.joined_on >= v_first_month
      AND au.joined_on <= p_to
    GROUP BY 1
  ),
  periods AS (
    SELECT gs::date AS bucket
    FROM generate_series(
      v_first_month::timestamp,
      date_trunc('month', p_to::timestamp),
      interval '1 month'
    ) AS gs
  )
  SELECT
    p.bucket,
    (b.base_total + sum(coalesce(j.joined_count, 0)) OVER (ORDER BY p.bucket))::bigint
  FROM periods p
  CROSS JOIN baseline b
  LEFT JOIN joined_by_month j ON j.bucket = p.bucket
  ORDER BY p.bucket;
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_active_participants(date, date)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.dashboard_active_participants(date, date)
TO service_role;
