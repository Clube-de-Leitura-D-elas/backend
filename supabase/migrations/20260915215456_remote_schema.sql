SET local check_function_bodies = off;

REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"(jsonb) FROM "anon";

REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"(jsonb) FROM "authenticated";

