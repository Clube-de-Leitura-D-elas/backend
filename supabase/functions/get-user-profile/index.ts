import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";

// Perfil (tabela users) da usuária autenticada.
// O withSupabase responde o preflight OPTIONS com os headers de CORS e valida o JWT.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (_req, ctx) => {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error } = await ctx.supabaseAdmin
    .from("users")
    .select("*")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("get-user-profile error", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true, profile });
}));
