import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

/**
 * Garante que quem chamou a função é uma usuária com app_role FOUNDER.
 * Retorna uma Response de erro para devolver direto, ou null quando o acesso é permitido.
 *
 * Use em funções declaradas com `withSupabase({ auth: "user" }, ...)`.
 */
export async function requireFounder(
  ctx: SupabaseContext<Database>,
): Promise<Response | null> {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error } = await ctx.supabaseAdmin
    .from("users")
    .select("app_role")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("founder check error", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (profile?.app_role !== "FOUNDER") {
    return Response.json({ error: "Forbidden: founder only" }, { status: 403 });
  }

  return null;
}
