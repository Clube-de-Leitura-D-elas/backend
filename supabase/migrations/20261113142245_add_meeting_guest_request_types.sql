-- Pedido de participação num encontro por quem não é do grupo (CLU-343): a
-- leitora pede pelo calendário e a anfitriã do encontro ou uma coordenadora do
-- grupo aceita ou recusa.
--
-- Valores de enum novos não podem ser usados na transação em que são criados,
-- por isso a tabela e as funções ficam na migration seguinte.

DO $$ BEGIN
  CREATE TYPE public.meeting_guest_request_status AS ENUM (
    'REQUESTED',
    'ACCEPTED',
    'REJECTED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_GUEST_REQUESTED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_GUEST_APPROVED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'MEETING_GUEST_REJECTED';
