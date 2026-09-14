import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/functions-js";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { readPendingUserId } from "../_shared/pendingUser.ts";

// Aprova uma solicitação pelo painel web. Body JSON: { pending_user_id }.
//
// Só marca is_approved = true. O trigger `on_pending_user_updated` gera o claim token
// e chama `approve-pending-user`, que envia o e-mail — o mesmo caminho do `approve-user`.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const pendingUserId = await readPendingUserId(req);
  if (pendingUserId instanceof Response) return pendingUserId;

  const { data: updated, error } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({ is_approved: true })
    .eq("id", pendingUserId)
    .eq("is_approved", false)
    .select("id");

  if (error) {
    console.error("accept-pending-user update error", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (updated.length > 0) {
    return Response.json({ ok: true, already_approved: false });
  }

  // Nada foi atualizado: ou a solicitação não existe, ou já estava aprovada.
  const { data: existing, error: fetchError } = await ctx.supabaseAdmin
    .from("pending_users")
    .select("id")
    .eq("id", pendingUserId)
    .maybeSingle();

  if (fetchError) {
    console.error("accept-pending-user fetch error", fetchError);
    return Response.json({ error: fetchError.message }, { status: 500 });
  }

  if (!existing) {
    return Response.json({ error: "pending user not found" }, { status: 404 });
  }

  return Response.json({ ok: true, already_approved: true });
}));
