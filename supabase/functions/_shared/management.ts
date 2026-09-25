import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

/**
 * Garante que quem chamou a função é uma usuária do painel de gestão.
 * MANAGER e FOUNDER possuem acesso.
 */
export async function requireManagement(
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
    console.error("management check error", error);

    return Response.json(
      { error: error.message },
      { status: 500 },
    );
  }

  if (
    profile?.app_role !== "MANAGER" &&
    profile?.app_role !== "FOUNDER"
  ) {
    return Response.json(
      { error: "Forbidden: management only" },
      { status: 403 },
    );
  }

  return null;
}