import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";
import { isPresent } from "../_shared/presence.ts";

const LAST_MEETINGS = 5;

// Presença da participante nos últimos encontros já realizados, em qualquer grupo.
// Query string: participant_id.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const participantId = readParticipantIdParam(new URL(req.url));
  if (participantId instanceof Response) return participantId;

  const { data: meetings, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, date, meeting_users!inner(user_id, presence_status)")
    .eq("meeting_users.user_id", participantId)
    .lte("date", new Date().toISOString())
    .order("date", { ascending: false })
    .limit(LAST_MEETINGS);

  if (error) {
    console.error("get-participant-presence meetings error", error);
    return Response.json({ error: error.message }, { status: 400 });
  }

  const items = (meetings ?? []).map((meeting) => {
    return {
      meeting_id: meeting.id,
      date: meeting.date,
      present: isPresent(meeting.meeting_users[0]?.presence_status),
    };
  });

  return Response.json({ items });
}));
