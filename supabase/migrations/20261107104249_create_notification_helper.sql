-- Base comum para criar avisos (CLU-296). Até aqui nada gravava em
-- `notifications`, e cada aviso do épico reinventaria a escrita.
--
-- `dedup_key` impede aviso duplicado quando o mesmo evento ou job roda de
-- novo. Formato: <TYPE>:<id do evento>[:<marco>], por exemplo
-- DRAW_RESULT:<meeting_raffle_id> ou MEETING_REMINDER:<meeting_id>:1d. É
-- nullable porque nem todo aviso vem de um evento repetível; o UNIQUE não
-- compara NULLs. A coluna entra vazia em todas as linhas, então o UNIQUE não
-- encontra duplicatas.
--
-- `create_notification` grava a notificação e uma linha por destinatária em
-- `notifications_targets` na mesma transação. Pode ser chamada de dentro de
-- outra função SQL, na transação do próprio evento, ou por RPC. Só a service
-- role executa; quem chama de outra função SQL precisa rodar como ela.

ALTER TYPE public.notification_type
  ADD VALUE IF NOT EXISTS 'ATTENDANCE_CONFIRMATION_REMINDER';

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedup_key text;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_dedup_key_key UNIQUE (dedup_key);

-- A get-my-notifications filtra os alvos por usuária na lista e no
-- unread_count; sem índice, as duas consultas varrem a tabela inteira.
CREATE INDEX IF NOT EXISTS notifications_targets_user_id_idx
  ON public.notifications_targets (user_id);

-- p_user_ids são ids de public.users (não de auth.users). Lista vazia não
-- cria nada e devolve NULL. Com dedup_key já usada, devolve o id existente sem
-- alterar a notificação nem as destinatárias.
CREATE OR REPLACE FUNCTION public.create_notification(
  p_type public.notification_type,
  p_title text,
  p_message text,
  p_user_ids uuid[],
  p_meeting_id uuid DEFAULT NULL,
  p_group_id uuid DEFAULT NULL,
  p_scheduled_for timestamp with time zone DEFAULT now(),
  p_dedup_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  recipient_ids uuid[];
  result_id uuid;
BEGIN
  SELECT array_agg(DISTINCT user_id)
  INTO recipient_ids
  FROM unnest(p_user_ids) AS user_id
  WHERE user_id IS NOT NULL;

  IF recipient_ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- meeting_id e group_id vão juntos para cada destinatária; sem esta
  -- checagem, um aviso poderia apontar para o encontro de outro grupo.
  IF p_meeting_id IS NOT NULL AND p_group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.meetings m
    WHERE m.id = p_meeting_id AND m.group_id = p_group_id
  ) THEN
    RAISE EXCEPTION 'meeting % does not belong to group %',
      p_meeting_id, p_group_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.notifications
    (title, message, type, scheduled_for, dedup_key)
  VALUES
    (p_title, p_message, p_type, coalesce(p_scheduled_for, now()), p_dedup_key)
  ON CONFLICT (dedup_key) DO NOTHING
  RETURNING id INTO result_id;

  IF result_id IS NULL THEN
    SELECT n.id
    INTO result_id
    FROM public.notifications n
    WHERE n.dedup_key = p_dedup_key;

    RETURN result_id;
  END IF;

  INSERT INTO public.notifications_targets
    (notification_id, user_id, meeting_id, group_id)
  SELECT result_id, recipient_id, p_meeting_id, p_group_id
  FROM unnest(recipient_ids) AS recipient_id;

  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_notification(
  public.notification_type, text, text, uuid[], uuid, uuid,
  timestamp with time zone, text
)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_notification(
  public.notification_type, text, text, uuid[], uuid, uuid,
  timestamp with time zone, text
)
TO service_role;
