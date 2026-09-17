import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";
// Dados do perfil de uma participante. Query string: participant_id.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  const participantId = readParticipantIdParam(new URL(req.url));
  if (participantId instanceof Response) return participantId;
  const { data, error } = await ctx.supabaseAdmin.from("users").select("id, name, phone, instagram, email, birth_date, job, is_active, cities(name), zones(name)").eq("id", participantId).maybeSingle();
  if (error) {
    console.error("get-participant error", error);
    return Response.json({
      error: error.message
    }, {
      status: 400
    });
  }
  if (!data) {
    return Response.json({
      error: "participant not found"
    }, {
      status: 404
    });
  }
  const { cities, zones, ...participant } = data;
  return Response.json({
    ...participant,
    city: cities?.name ?? null,
    zone: zones?.name ?? null
  });
}));
