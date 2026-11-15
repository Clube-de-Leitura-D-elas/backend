-- O e-mail de aprovação passa a ser enviado pela própria edge function que
-- aprova (`accept-pending-user`), então o trigger que fazia isso deixa de
-- existir.
--
-- O trigger existia porque havia dois caminhos de aprovação: o painel
-- (`accept-pending-user`) e o link HMAC do e-mail (`approve-user`, disparado
-- por `send-user-to-approval`). O link não é mais usado — o painel chama
-- `accept-pending-user` direto — e as duas functions são removidas no mesmo PR.
--
-- Com o trigger saem junto: a geração do claim_token dentro do Postgres e a
-- chamada de edge function por `pg_net` (que dependia de `pg_net` habilitado e
-- dos secrets `edge_api_key`/`edge_base_url` no Vault). O banco deixa de ser
-- cliente HTTP: quem aprova é a function, que responde se o e-mail saiu ou não.
--
-- Dados existentes: nenhuma linha é apagada nem alterada. As solicitações já
-- aprovadas mantêm o `claim_token` e o `claim_token_expires_at` que o trigger
-- gravou, e continuam ativáveis no app.

DROP TRIGGER IF EXISTS on_pending_user_updated ON public.pending_users;
DROP FUNCTION IF EXISTS public.handle_pending_user_updates();
