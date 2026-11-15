-- Lista "Participantes que faltaram aos últimos 3 encontros" do dashboard do
-- painel web (CLU-254, edge function `get-dashboard-absences-web`).
--
-- `dashboard_recent_absences` devolve um par participante + grupo para cada
-- integrante que não esteve presente em nenhum dos 3 últimos encontros
-- realizados do grupo, com a data do último encontro em que esteve presente
-- naquele grupo (nula se nunca esteve).
--
-- Regra:
--   * Entra o vínculo com `group_users.registration_status = 'ACTIVE'`, conta
--     com `users.is_active = true` e grupo com `groups.is_active = true`.
--   * Encontro realizado = `meetings.status IN ('ENDED', 'CONCLUDED')`, com data.
--     Os 3 últimos são os de data mais recente do grupo (`row_number()` por
--     grupo, `date` desc).
--   * A regra é por grupo: presença em encontro de outro grupo não conta, e a
--     mesma participante pode aparecer uma vez para cada grupo em que faltou.
--   * Presença compara como `isPresent` (`_shared/presence.ts`): "present" ou
--     "presente", sem caixa. `presence_status` nulo ou ausência de linha em
--     `meeting_users` não é presença.
--   * Não usa `group_users.last_consecutive_absences`: nenhuma edge function
--     atualiza esse valor.
--
-- Decisões que a issue não fecha (a confirmar com o time):
--   1. Grupo com menos de 3 encontros realizados não entra: não dá para dizer
--      que alguém faltou a 3.
--   2. Integrante recente só entra se já estava no grupo nos 3 encontros
--      considerados: data de `group_users.created_at` <= data do mais antigo
--      dos 3 (as duas em America/Sao_Paulo). Armadilha: a coluna foi criada em
--      01/10/2026 sem backfill (`20261001150000_add_group_users_created_at`), e
--      todo vínculo anterior ficou com o horário do deploy (01/10/2026, ~02h).
--      Por isso vínculo com `created_at` antes de 02/10/2026 (SP) conta como
--      entrada desconhecida e é tratado como se já estivesse no grupo; sem
--      isso, quase todas as participantes antigas sumiriam da lista.
--   3. Encontro realizado sem nenhuma presença registrada (ninguém com
--      `presence_status` preenchido, porque `set-meeting-presence` não foi
--      chamado) é ignorado ao escolher os 3 últimos, para não marcar o grupo
--      inteiro como faltoso.
--   4. A data da última presença olha todos os encontros realizados do grupo,
--      não só os 3 últimos.
--
-- Limitações:
--   * `registration_status` e `is_active` são o estado de hoje: quem saiu e
--     voltou ao grupo aparece com a data de entrada original.
--
-- Só cria a função: não altera tabelas nem dados. Execução só pela service role.

CREATE OR REPLACE FUNCTION public.dashboard_recent_absences()
RETURNS TABLE (
  user_id uuid,
  user_name text,
  group_id uuid,
  group_number integer,
  group_description text,
  last_presence_at timestamp with time zone
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH held AS (
    SELECT m.id, m.group_id, m.date
    FROM public.meetings m
    JOIN public.groups g ON g.id = m.group_id AND g.is_active
    WHERE m.status IN ('ENDED', 'CONCLUDED')
      AND m.date IS NOT NULL
  ),
  with_attendance AS (
    SELECT h.*
    FROM held h
    WHERE EXISTS (
      SELECT 1
      FROM public.meeting_users mu
      WHERE mu.meeting_id = h.id
        AND mu.presence_status IS NOT NULL
    )
  ),
  ranked AS (
    SELECT
      wa.id,
      wa.group_id,
      wa.date,
      row_number() OVER (
        PARTITION BY wa.group_id
        ORDER BY wa.date DESC, wa.id
      ) AS position
    FROM with_attendance wa
  ),
  last_three AS (
    SELECT
      r.group_id,
      array_agg(r.id) AS meeting_ids,
      min(r.date) AS oldest_date
    FROM ranked r
    WHERE r.position <= 3
    GROUP BY r.group_id
    HAVING count(*) = 3
  ),
  absentees AS (
    SELECT gu.user_id, gu.group_id
    FROM public.group_users gu
    JOIN last_three lt ON lt.group_id = gu.group_id
    JOIN public.users u ON u.id = gu.user_id AND u.is_active
    WHERE gu.registration_status = 'ACTIVE'
      AND (
        gu.created_at < timestamptz '2026-10-02 00:00:00-03'
        OR (gu.created_at AT TIME ZONE 'America/Sao_Paulo')::date
          <= (lt.oldest_date AT TIME ZONE 'America/Sao_Paulo')::date
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.meeting_users mu
        WHERE mu.user_id = gu.user_id
          AND mu.meeting_id = ANY (lt.meeting_ids)
          AND lower(trim(mu.presence_status::text)) IN ('present', 'presente')
      )
  )
  SELECT
    a.user_id,
    u.name::text,
    g.id,
    g.number,
    g.description::text,
    (
      SELECT max(h.date)
      FROM held h
      JOIN public.meeting_users mu
        ON mu.meeting_id = h.id
        AND mu.user_id = a.user_id
      WHERE h.group_id = a.group_id
        AND lower(trim(mu.presence_status::text)) IN ('present', 'presente')
    )
  FROM absentees a
  JOIN public.users u ON u.id = a.user_id
  JOIN public.groups g ON g.id = a.group_id;
$$;

REVOKE ALL ON FUNCTION public.dashboard_recent_absences()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.dashboard_recent_absences()
TO service_role;
