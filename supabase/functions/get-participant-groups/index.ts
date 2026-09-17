import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";
// Grupos de uma participante, paginados. Query string: participant_id, page, pageSize.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const participantId = readParticipantIdParam(url);
  if (participantId instanceof Response) return participantId;
  const { from, to } = parseListParams(url);
  const { data, error, count } = await ctx.supabaseAdmin.from("group_users").select("id, is_coordinator, groups!inner(id, number, cities(name))", {
    count: "exact"
  }).eq("user_id", participantId).order("id").range(from, to);
  if (error) {
    console.error("get-participant-groups error", error);
    return Response.json({
      error: error.message
    }, {
      status: 400
    });
  }
  const memberships = data ?? [];
  const items = memberships.map((membership)=>({
      id: membership.groups.id,
      number: membership.groups.number,
      city: membership.groups.cities?.name ?? null,
      is_coordinator: membership.is_coordinator
    }));
  return Response.json({
    items,
    total: count ?? 0
  });
}));
