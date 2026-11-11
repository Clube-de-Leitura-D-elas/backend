-- Lembretes de encontro (CLU-67), rodados todo dia pelo agendador da CLU-298.
--
-- Pedido de confirmação (ATTENDANCE_CONFIRMATION_REMINDER): a quem ainda não
-- respondeu o convite, para encontros SCHEDULED de amanhã até daqui a 3 dias.
-- A janela começa no D-3, mas vai até o D-1 para que um encontro marcado em
-- cima da hora, ou um dia em que o job falhou, não fique sem o pedido.
--
-- Encontro amanhã (MEETING_REMINDER): no D-1, a quem não recusou.
--
-- "Dias" são do calendário de São Paulo: o job roda às 09:00 de lá, então um
-- encontro dia 13 recebe o pedido de confirmação a partir do dia 10 e o aviso
-- de véspera no dia 12, qualquer que seja o horário. Encontro sem data ou fora
-- de SCHEDULED não entra.
--
-- A dedup_key leva o dia do encontro: rodar o job de novo não duplica, e um
-- encontro remarcado ganha avisos novos, com a data certa no texto.

-- Participantes de um encontro com a resposta ao convite, como o app enxerga:
-- quem não tem linha em meeting_users ainda não respondeu (PENDING), porque a
-- linha só nasce quando a pessoa responde ou quando a presença é marcada.
-- Entram as participantes ativas do grupo do encontro (inclusive a anfitriã)
-- e, à parte, quem está em meeting_users sem ser do grupo (convidadas de
-- outros grupos; hoje só existem no seed). Contas desativadas ficam de fora.
CREATE OR REPLACE FUNCTION public.meeting_invitation_statuses(
  p_meeting_id uuid
)
RETURNS TABLE (user_id uuid, invitation_status public.invitation_status)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT gu.user_id, coalesce(mu.invitation_status, 'PENDING')
  FROM public.meetings m
  JOIN public.group_users gu
    ON gu.group_id = m.group_id AND gu.registration_status = 'ACTIVE'
  JOIN public.users u ON u.id = gu.user_id AND u.is_active
  LEFT JOIN public.meeting_users mu
    ON mu.meeting_id = m.id AND mu.user_id = gu.user_id
  WHERE m.id = p_meeting_id

  UNION

  SELECT mu.user_id, mu.invitation_status
  FROM public.meetings m
  JOIN public.meeting_users mu ON mu.meeting_id = m.id
  JOIN public.users u ON u.id = mu.user_id AND u.is_active
  WHERE m.id = p_meeting_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.group_users gu
      WHERE gu.user_id = mu.user_id AND gu.group_id = m.group_id
    );
$$;

CREATE OR REPLACE FUNCTION public.notify_meeting_reminders()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  meeting record;
  meeting_when text;
  meeting_place text;
BEGIN
  FOR meeting IN
    SELECT
      m.id,
      m.date,
      (m.date AT TIME ZONE 'America/Sao_Paulo')::date AS local_day,
      b.name AS book_name,
      l.name AS location_name
    FROM public.meetings m
    JOIN public.books b ON b.id = m.book_id
    LEFT JOIN public.locations l ON l.id = m.location_id
    WHERE m.status = 'SCHEDULED'
      AND m.date IS NOT NULL
      AND (m.date AT TIME ZONE 'America/Sao_Paulo')::date
        BETWEEN today + 1 AND today + 3
  LOOP
    meeting_when := to_char(
      meeting.date AT TIME ZONE 'America/Sao_Paulo',
      'DD/MM "às" HH24"h"MI'
    );
    meeting_place := coalesce(meeting.location_name, 'local a definir');

    PERFORM public.create_notification(
      'ATTENDANCE_CONFIRMATION_REMINDER',
      'Confirme sua presença',
      format(
        'Encontro de "%s" em %s, %s. Você vai? Confirme sua presença.',
        meeting.book_name, meeting_when, meeting_place
      ),
      ARRAY(
        SELECT s.user_id
        FROM public.meeting_invitation_statuses(meeting.id) s
        WHERE s.invitation_status = 'PENDING'
      ),
      p_meeting_id => meeting.id,
      p_dedup_key => 'ATTENDANCE_CONFIRMATION_REMINDER:' || meeting.id
        || ':' || meeting.local_day
    );

    IF meeting.local_day = today + 1 THEN
      PERFORM public.create_notification(
        'MEETING_REMINDER',
        'Encontro amanhã',
        format(
          'Amanhã tem encontro de "%s" em %s, %s.',
          meeting.book_name, meeting_when, meeting_place
        ),
        ARRAY(
          SELECT s.user_id
          FROM public.meeting_invitation_statuses(meeting.id) s
          WHERE s.invitation_status <> 'DECLINED'
        ),
        p_meeting_id => meeting.id,
        p_dedup_key => 'MEETING_REMINDER:' || meeting.id || ':1d:'
          || meeting.local_day
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.meeting_invitation_statuses(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.meeting_invitation_statuses(uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.notify_meeting_reminders()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.notify_meeting_reminders()
TO service_role;

INSERT INTO public.scheduled_notification_steps (function_name)
VALUES ('notify_meeting_reminders')
ON CONFLICT (function_name) DO NOTHING;