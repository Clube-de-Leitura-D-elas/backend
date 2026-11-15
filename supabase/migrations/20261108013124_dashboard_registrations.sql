-- Gráfico "Novas inscrições" do dashboard do painel web (CLU-249, edge
-- function `get-dashboard-registrations-web`).
-- Só cria a função: não altera tabelas nem dados. Execução só pela service role.

CREATE OR REPLACE FUNCTION public.dashboard_registrations(
  p_from date,
  p_to date,
  p_granularity text
)
RETURNS TABLE (
  period date,
  total bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_granularity IS NULL OR p_granularity NOT IN ('month', 'week') THEN
    RAISE EXCEPTION 'invalid granularity: %', p_granularity;
  END IF;

  RETURN QUERY
  WITH periods AS (
    SELECT gs::date AS bucket
    FROM generate_series(
      date_trunc(p_granularity, p_from::timestamp),
      p_to::timestamp,
      ('1 ' || p_granularity)::interval
    ) AS gs
  ),
  registrations AS (
    SELECT
      date_trunc(
        p_granularity,
        pu.created_at AT TIME ZONE 'America/Sao_Paulo'
      )::date AS bucket,
      count(*) AS registrations_count
    FROM public.pending_users pu
    WHERE (pu.created_at AT TIME ZONE 'America/Sao_Paulo')::date
      BETWEEN date_trunc(p_granularity, p_from::timestamp)::date AND p_to
    GROUP BY 1
  )
  SELECT p.bucket, coalesce(r.registrations_count, 0)
  FROM periods p
  LEFT JOIN registrations r ON r.bucket = p.bucket
  ORDER BY p.bucket;
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_registrations(date, date, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.dashboard_registrations(date, date, text)
TO service_role;
