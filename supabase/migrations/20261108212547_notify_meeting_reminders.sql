-- Lembretes de encontro (CLU-67), rodados todo dia pelo agendador da CLU-298.
--
-- D-3 (ATTENDANCE_CONFIRMATION_REMINDER): pede para confirmar presença a quem
-- ainda não respondeu o convite. D-1 (MEETING_REMINDER): avisa que o encontro
-- é amanhã a quem não recusou.
--
-- "D-3" e "D-1" são dias do calendário de São Paulo: o job roda às 09:00 de
-- lá, então um encontro dia 13 recebe o lembrete de confirmação no dia 10 e o
-- de véspera no dia 12, qualquer que seja o horário. Encontro sem data ou fora
-- de SCHEDULED não entra.
--
-- Destinatárias vêm de meeting_users, incluindo convidadas de outros grupos;
-- quem saiu do grupo do encontro ou teve a conta desativada fica de fora.
--
-- A dedup_key é por encontro, então rodar o job de novo no mesmo dia não
-- duplica. Limitação: o texto (com data e local) fica como no dia do aviso.
-- Se o encontro for remarcado depois disso, o aviso não é recriado.
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
      m.group_id,
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
        IN (today + 1, today + 3)
  LOOP
    meeting_when := to_char(
      meeting.date AT TIME ZONE 'America/Sao_Paulo',
      'DD/MM "às" HH24"h"MI'
    );
    meeting_place := coalesce(meeting.location_name, 'local a definir');

    IF meeting.local_day = today + 3 THEN
      PERFORM public.create_notification(
        'ATTENDANCE_CONFIRMATION_REMINDER',
        'Confirme sua presença',
        format(
          'Encontro de "%s" em %s, %s. Você vai? Confirme sua presença.',
          meeting.book_name, meeting_when, meeting_place
        ),
        ARRAY(
          SELECT mu.user_id
          FROM public.meeting_users mu
          JOIN public.users u ON u.id = mu.user_id
          WHERE mu.meeting_id = meeting.id
            AND mu.invitation_status = 'PENDING'
            AND u.is_active
            AND NOT EXISTS (
              SELECT 1
              FROM public.group_users gu
              WHERE gu.user_id = mu.user_id
                AND gu.group_id = meeting.group_id
                AND gu.registration_status <> 'ACTIVE'
            )
        ),
        p_meeting_id => meeting.id,
        p_dedup_key => 'ATTENDANCE_CONFIRMATION_REMINDER:' || meeting.id
      );
    ELSE
      PERFORM public.create_notification(
        'MEETING_REMINDER',
        'Encontro amanhã',
        format(
          'Amanhã tem encontro de "%s" em %s, %s.',
          meeting.book_name, meeting_when, meeting_place
        ),
        ARRAY(
          SELECT mu.user_id
          FROM public.meeting_users mu
          JOIN public.users u ON u.id = mu.user_id
          WHERE mu.meeting_id = meeting.id
            AND mu.invitation_status <> 'DECLINED'
            AND u.is_active
            AND NOT EXISTS (
              SELECT 1
              FROM public.group_users gu
              WHERE gu.user_id = mu.user_id
                AND gu.group_id = meeting.group_id
                AND gu.registration_status <> 'ACTIVE'
            )
        ),
        p_meeting_id => meeting.id,
        p_dedup_key => 'MEETING_REMINDER:' || meeting.id || ':1d'
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_meeting_reminders()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.notify_meeting_reminders()
TO service_role;

INSERT INTO public.scheduled_notification_steps (function_name)
VALUES ('notify_meeting_reminders')
ON CONFLICT (function_name) DO NOTHING;