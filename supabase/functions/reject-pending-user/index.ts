import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { readPendingUserId } from "../_shared/pendingUser.ts";
// Recusa uma solicitação pelo painel web, apagando o registro de pending_users.
// Body JSON: { pending_user_id }. Solicitações já aprovadas não são apagadas,
// porque a participante pode já ter recebido o claim token.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  const pendingUserId = await readPendingUserId(req);
  if (pendingUserId instanceof Response) return pendingUserId;
  const { data: deleted, error } = await ctx.supabaseAdmin.from("pending_users").delete().eq("id", pendingUserId).eq("is_approved", false).select("id");
  if (error) {
    console.error("reject-pending-user delete error", error);
    return Response.json({
      error: error.message
    }, {
      status: 500
    });
  }
  if (deleted.length > 0) {
    return Response.json({
      ok: true
    });
  }
  // Nada foi apagado: ou a solicitação não existe, ou já foi aprovada.
  const { data: existing, error: fetchError } = await ctx.supabaseAdmin.from("pending_users").select("id").eq("id", pendingUserId).maybeSingle();
  if (fetchError) {
    console.error("reject-pending-user fetch error", fetchError);
    return Response.json({
      error: fetchError.message
    }, {
      status: 500
    });
  }
  if (!existing) {
    return Response.json({
      error: "pending user not found"
    }, {
      status: 404
    });
  }
  return Response.json({
    error: "pending user already approved"
  }, {
    status: 409
  });
}));
