import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { isUuid } from "../_shared/uuid.ts";
// Ativa ou inativa uma participante. Body JSON: { participant_id, is_active }.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  if (req.method !== "POST") {
    return Response.json({
      error: "expected POST request"
    }, {
      status: 405
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return Response.json({
      error: "expected JSON body"
    }, {
      status: 400
    });
  }
  const participantId = body?.participant_id;
  const isActive = body?.is_active;
  if (!isUuid(participantId)) {
    return Response.json({
      error: 'missing/invalid "participant_id"'
    }, {
      status: 400
    });
  }
  if (typeof isActive !== "boolean") {
    return Response.json({
      error: 'missing/invalid "is_active"'
    }, {
      status: 400
    });
  }
  const { data, error } = await ctx.supabaseAdmin.from("users").update({
    is_active: isActive
  }).eq("id", participantId).select("is_active").maybeSingle();
  if (error) {
    console.error("update-participant-status error", error);
    return Response.json({
      error: error.message
    }, {
      status: 500
    });
  }
  if (!data) {
    return Response.json({
      error: "participant not found"
    }, {
      status: 404
    });
  }
  return Response.json({
    is_active: data.is_active
  });
}));
