import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { oneLine } from "./log.ts";

export type AppRole = "READER" | "MANAGER" | "FOUNDER";

/**
 * Garante que quem chamou a função tem um dos `roles` em `users.app_role`.
 * Retorna uma Response de erro para devolver direto, ou null quando o acesso é permitido.
 *
 * `scope` nomeia o acesso no 403 e no log ("Forbidden: <scope> only").
 *
 * Use em funções declaradas com `withSupabase({ auth: "user" }, ...)`.
 */
export async function requireRole(
  ctx: SupabaseContext<Database>,
  roles: readonly AppRole[],
  scope = roles.join(" or ").toLowerCase(),
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
    console.error(`${scope} check error`, oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!roles.includes(profile?.app_role)) {
    return Response.json(
      { error: `Forbidden: ${scope} only` },
      { status: 403 },
    );
  }

  return null;
}
