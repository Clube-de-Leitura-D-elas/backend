-- Pedido de entrada em grupo pelo app (CLU-285): a leitora pede, a coordenadora
-- aprova ou recusa. O pedido é uma linha em group_users com status próprio:
-- REQUESTED (aguardando a coordenadora) e REJECTED (recusado; pode pedir de novo).
--
-- REQUESTED e não PENDING: PENDING fica reservado para "aguardando criação de
-- conta" (CLU-284), que tem outra regra de aprovação.
--
-- Valores de enum novos não podem ser usados na mesma transação em que são
-- criados, por isso as mudanças em group_users ficam na migration seguinte.

ALTER TYPE public.registration_status ADD VALUE IF NOT EXISTS 'REQUESTED';
ALTER TYPE public.registration_status ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'GROUP_JOIN_REQUESTED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'GROUP_JOIN_APPROVED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'GROUP_JOIN_REJECTED';
