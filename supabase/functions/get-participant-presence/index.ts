import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";

const LAST_MEETINGS = 5;
const PRESENT_STATUSES = new Set(["present", "presente"]);

// Presença da participante nos últimos encontros já realizados, em qualquer grupo.
// Query string: participant_id.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const participantId = readParticipantIdParam(new URL(req.url));
  if (participantId instanceof Response) return participantId;

  const { data: memberships, error: membershipsError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id")
    .eq("user_id", participantId);

  if (membershipsError) {
    console.error("get-participant-presence memberships error", membershipsError);
    return Response.json({ error: membershipsError.message }, { status: 400 });
  }

  const membershipIds = (memberships ?? []).map((membership) => membership.id);
  if (membershipIds.length === 0) {
    return Response.json({ items: [] });
  }

  const { data: meetings, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, date, meeting_group_users!inner(group_user_id, presence_status)")
    .in("meeting_group_users.group_user_id", membershipIds)
    .lte("date", new Date().toISOString())
    .order("date", { ascending: false })
    .limit(LAST_MEETINGS);

  if (error) {
    console.error("get-participant-presence meetings error", error);
    return Response.json({ error: error.message }, { status: 400 });
  }

  const items = (meetings ?? []).map((meeting) => {
    const status: string = meeting.meeting_group_users[0]?.presence_status ?? "";
    return {
      meeting_id: meeting.id,
      date: meeting.date,
      present: PRESENT_STATUSES.has(status.trim().toLowerCase()),
    };
  });

  return Response.json({ items });
}));
