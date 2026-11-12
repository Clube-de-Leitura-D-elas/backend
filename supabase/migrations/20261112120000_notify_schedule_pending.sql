-- Avisa a anfitriã e as coordenadoras quando o rascunho criado pelo sorteio
-- continua sem data ou local. O marco usa drawn_at, que é o momento em que o
-- sorteio criou o próximo encontro, e cada múltiplo de sete dias gera um aviso
-- novo enquanto a pendência continuar.

CREATE OR REPLACE FUNCTION public.notify_schedule_pending()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  today timestamp with time zone := now();
  meeting record;
  pending_items text;
  milestone integer;
BEGIN
  FOR meeting IN
    SELECT
      m.id,
      m.group_id,
      m.host_id,
      m.date,
      m.location_id,
      m.status,
      mr.drawn_at,
      b.name AS book_name
    FROM public.meetings m
    JOIN public.meeting_raffles mr ON mr.next_meeting_id = m.id
    JOIN public.books b ON b.id = m.book_id
    WHERE (m.status = 'CREATED' OR m.date IS NULL OR m.location_id IS NULL)
      AND today >= mr.drawn_at + interval '7 days'
  LOOP
    milestone := floor(
      extract(epoch FROM (today - meeting.drawn_at)) / (7 * 24 * 60 * 60)
    )::integer * 7;

    pending_items := CASE
      WHEN meeting.date IS NULL AND meeting.location_id IS NULL
        THEN 'data e local'
      WHEN meeting.date IS NULL THEN 'data'
      WHEN meeting.location_id IS NULL THEN 'local'
      ELSE 'confirmação do agendamento'
    END;

    PERFORM public.create_notification(
      'MEETING_SCHEDULE_PENDING',
      'Encontro ainda não agendado',
      format(
        'O próximo encontro de "%s" ainda está sem %s. Defina essa informação para concluir o agendamento.',
        meeting.book_name, pending_items
      ),
      ARRAY(
        SELECT DISTINCT recipient.user_id
        FROM (
          SELECT host.user_id
          FROM public.group_users host
          JOIN public.users host_user ON host_user.id = host.user_id
          WHERE host.id = meeting.host_id
            AND host.registration_status = 'ACTIVE'
            AND host_user.is_active

          UNION

          SELECT coordinator.user_id
          FROM public.group_users coordinator
          JOIN public.users coordinator_user
            ON coordinator_user.id = coordinator.user_id
          WHERE coordinator.group_id = meeting.group_id
            AND coordinator.is_coordinator
            AND coordinator.registration_status = 'ACTIVE'
            AND coordinator_user.is_active
        ) AS recipient
      ),
      p_meeting_id => meeting.id,
      p_group_id => meeting.group_id,
      p_dedup_key => 'MEETING_SCHEDULE_PENDING:' || meeting.id || ':d'
        || milestone
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_schedule_pending()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.notify_schedule_pending()
TO service_role;

INSERT INTO public.scheduled_notification_steps (function_name)
VALUES ('notify_schedule_pending')
ON CONFLICT (function_name) DO NOTHING;
