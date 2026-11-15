-- Gráfico "Total de Participantes" do dashboard do painel web (CLU-251, edge
-- function `get-dashboard-active-participants-web`).
--
-- `dashboard_active_participants` devolve, para cada mês entre `p_from` e `p_to`,
-- quantas participantes ativas o clube tinha ao fim do mês. O valor é um
-- ESTOQUE (acumulado), não quantas entraram no mês.
--
-- Regra (decisão a confirmar com o time):
--   * Participante = linha de `public.users` com `is_active = true`, de qualquer
--     `app_role`. Gestoras (MANAGER/FOUNDER) também participam de grupos, então
--     contam. O KPI "Participantes ativas" do card de grupos (CLU-252) deve usar
--     o mesmo filtro: o último ponto desta série (mês corrente) é igual a ele.
--
-- Limitação do histórico:
--   * O banco não guarda quando alguém deixou de ser ativa: `users.is_active` é
--     só o estado de hoje, e `group_users.created_at` não serve antes de
--     01/10/2026. Por isso cada mês conta quem entrou até ali (`users.created_at`)
--     E AINDA ESTÁ ATIVA HOJE. É uma aproximação: desativar uma conta reduz todos
--     os pontos passados dela, e meses antigos não mostram quem já saiu.
--
-- Decisões não óbvias:
--   * Corte em `p_to`: o mês de `p_to` (o corrente) conta só até `p_to`, não até
--     o fim do mês. Se `p_from` cair no meio de um mês, o primeiro ponto continua
--     sendo o estoque do fim daquele mês.
--   * Datas em America/Sao_Paulo: quem entrou em 31/10 às 23h30 (SP) conta em
--     outubro, mesmo sendo novembro em UTC.
--   * Cálculo: linha de base (quem entrou antes do primeiro mês) + soma
--     acumulada das entradas de cada mês, em vez de uma contagem por mês.
--   * Mês sem entrada repete o total do mês anterior.
--   * Não limita o tamanho do intervalo: a edge function recusa intervalos
--     grandes antes de chamar.
--
-- Só cria a função: não altera tabelas nem dados. Execução só pela service role.

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
