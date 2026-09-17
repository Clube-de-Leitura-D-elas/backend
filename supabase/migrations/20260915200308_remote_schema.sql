SET local check_function_bodies = off;

CREATE EXTENSION "pg_net" SCHEMA "extensions";

ALTER TABLE "public"."book_reviews"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."book_suggestions"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."books"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."cities"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."group_users"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."groups"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."locations"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."meeting_group_users"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."meeting_guests"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."meeting_photos"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."meetings"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."notifications_targets"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."notifications"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."pending_users"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."photos"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."users"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."zones"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook (
  event jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
  RETURNS event_trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'pg_catalog'
  AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

CREATE POLICY "Auth admin reads app_role for access token" ON "public"."users"
  FOR SELECT
  TO "supabase_auth_admin"
  USING (true);

CREATE EVENT TRIGGER "ensure_rls"
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION "public"."rls_auto_enable"();

COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';

REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."custom_access_token_hook"(jsonb) TO "postgres", "service_role", "supabase_auth_admin";

GRANT EXECUTE ON FUNCTION "public"."rls_auto_enable"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

REVOKE ALL ON SCHEMA "public" FROM "supabase_auth_admin";

GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";

REVOKE ALL ON TABLE "public"."pending_users" FROM "anon";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."pending_users" TO "anon";

REVOKE ALL ("app_role") ON TABLE "public"."users" FROM "supabase_auth_admin";

GRANT SELECT ("app_role") ON TABLE "public"."users" TO "supabase_auth_admin";

REVOKE ALL ("user_id") ON TABLE "public"."users" FROM "supabase_auth_admin";

GRANT SELECT ("user_id") ON TABLE "public"."users" TO "supabase_auth_admin";

