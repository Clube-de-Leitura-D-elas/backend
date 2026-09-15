-- Custom Access Token Hook: coloca o app_role da usuária (public.users) no JWT como claim `app_role`.
-- Roda sempre que o Auth emite ou renova um token, então uma mudança de papel só aparece
-- no próximo refresh (até 1h). As edge functions continuam conferindo o papel no banco.
-- Usuárias sem linha em public.users recebem `app_role: null`.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  user_app_role public.app_roles;
BEGIN
  SELECT app_role INTO user_app_role
  FROM public.users
  WHERE user_id = (event->>'user_id')::uuid;

  claims := event->'claims';
  claims := jsonb_set(claims, '{app_role}', coalesce(to_jsonb(user_app_role), 'null'::jsonb));

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- Só o Auth pode chamar o hook.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;

-- O Auth só precisa ler estas duas colunas.
GRANT SELECT (user_id, app_role) ON TABLE public.users TO supabase_auth_admin;

-- Caso o RLS seja ativado em public.users, o hook continua lendo o papel.
DROP POLICY IF EXISTS "Auth admin reads app_role for access token" ON public.users;
CREATE POLICY "Auth admin reads app_role for access token"
  ON public.users
  AS PERMISSIVE
  FOR SELECT
  TO supabase_auth_admin
  USING (true);
