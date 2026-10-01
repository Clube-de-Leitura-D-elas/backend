import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { requireRole } from "./role.ts";

/**
 * Garante que quem chamou a função é uma usuária com app_role FOUNDER.
 * Retorna uma Response de erro para devolver direto, ou null quando o acesso é permitido.
 *
 * Use em funções declaradas com `withSupabase({ auth: "user" }, ...)`.
 */
export function requireFounder(
  ctx: SupabaseContext<Database>,
): Promise<Response | null> {
  return requireRole(ctx, ["FOUNDER"]);
}
