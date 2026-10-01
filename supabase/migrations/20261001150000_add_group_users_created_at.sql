-- Data de entrada da participante no grupo.
--
-- A lista de participantes da tela de detalhes do grupo mostra "DATA DE
-- ENTRADA", e `group_users` não guardava quando o vínculo foi criado.
--
-- Vínculos já existentes assumem o momento da migration: não há registro
-- histórico de quando cada uma entrou.
--
-- RLS: `group_users` segue sem RLS, como as outras tabelas do schema (o acesso
-- é feito pelas edge functions com service role). Nenhuma política nova é
-- necessária para acrescentar a coluna.
ALTER TABLE public.group_users
ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now();
