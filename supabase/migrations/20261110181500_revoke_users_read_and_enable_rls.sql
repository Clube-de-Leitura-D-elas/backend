-- Revoga a leitura direta de `public.users` pelo Data API para `authenticated` e
-- `anon`, e ativa Row Level Security (RLS) em todas as tabelas do schema
-- `public` que foram criadas antes de a regra de RLS virar padrão no repositório.
--
-- Por que isso é seguro:
-- 1. O modal de criação de grupo no painel web, que motivou o GRANT original em
--    `20261006120000_grant_read_reference_tables.sql`, já migrou para a Edge
--    Function `get-group-form-options` (que consulta o banco via `service_role`).
--    Nem o `web` nem o `mobile` fazem `.from("users")` diretamente.
-- 2. O hook de autenticação `public.custom_access_token_hook` lê `public.users`
--    com a role `supabase_auth_admin`, que já possui tanto `GRANT SELECT` quanto
--    a policy `"Auth admin reads app_role for access token"` criada em
--    `20260914120000_custom_access_token_hook.sql`.
-- 3. `cities` e `zones` continuam com `GRANT SELECT` para `authenticated` e
--    ganham policies explícitas de leitura para manter o contrato documentado.

REVOKE ALL ON TABLE public.users FROM anon, authenticated;

ALTER TABLE public.book_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_raffles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read cities"
  ON public.cities
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read zones"
  ON public.zones
  FOR SELECT
  TO authenticated
  USING (true);
