-- Suporte ao pedido de entrada em grupo (CLU-285).
--
-- UNIQUE (group_id, user_id): pedir de novo depois de recusada reaproveita a
-- mesma linha (REJECTED -> REQUESTED) em vez de criar outra. Hoje nenhum fluxo
-- grava vínculo repetido (o único INSERT é o da coordenadora em create_group) e
-- a consulta de duplicatas em produção retornou zero em 12-11-2026, então não
-- há limpeza a fazer. Se aparecer duplicata até o deploy, a migration aborta.
--
-- requested_at: quando o pedido foi feito (ou refeito). Ordena a fila da
-- coordenadora. Fica nulo para vínculos que não passaram por pedido.

ALTER TABLE public.group_users
  ADD CONSTRAINT group_users_group_id_user_id_key UNIQUE (group_id, user_id);

ALTER TABLE public.group_users
  ADD COLUMN requested_at timestamptz;
