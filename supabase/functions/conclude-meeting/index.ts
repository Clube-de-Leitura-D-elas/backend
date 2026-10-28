import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { canConclude } from "../_shared/meetingTasks.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "conclude-meeting";
const CONCLUDABLE_STATUSES = ["SCHEDULED", "IN_PROGRESS"];

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
  date: string | null;
  location_id: string | null;
};

// Chamada pelo app ao concluir a lista de presença aberta por
// "Encerrar encontro". Abrir a lista e voltar não chama esta função.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, group_id, host_id, status, date, location_id")
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(`${LOG_LABEL} meeting error`, oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  const member = await requireGroupMemberProfile(ctx, meeting.group_id, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

  const allowed = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    LOG_LABEL,
  );
  if (allowed instanceof Response) return allowed;
  if (!allowed) {
    return Response.json({
      error: "Forbidden: group coordinators or meeting host only.",
    }, { status: 403 });
  }

  if (!canConclude(meeting)) {
    return Response.json({ error: "meeting cannot be concluded yet" }, {
      status: 409,
    });
  }

  const { data: updated, error: updateError } = await ctx.supabaseAdmin
    .from("meetings")
    .update({ status: "CONCLUDED" })
    .eq("id", meeting.id)
    .in("status", CONCLUDABLE_STATUSES)
    .select("id, status")
    .maybeSingle();

  if (updateError) {
    console.error(`${LOG_LABEL} update error`, oneLine(updateError.message));
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  if (!updated) {
    return Response.json({ error: "meeting cannot be concluded yet" }, {
      status: 409,
    });
  }

  return Response.json({ id: updated.id, status: updated.status });
}));
