import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { readMeetingIdParam } from "../_shared/meeting.ts";

const ACTIVE_MEETING_STATUSES = ["CREATED", "SCHEDULED", "IN_PROGRESS"];

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, group_id, host_id, status")
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(
      "get-meeting-tasks error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  const member = await requireGroupMemberProfile(ctx, meeting.group_id);
  if (member instanceof Response) return member;

  if (!ACTIVE_MEETING_STATUSES.includes(meeting.status)) {
    return Response.json({
      meeting_id: meeting.id,
      status: meeting.status,
      can_manage_tasks: false,
    });
  }

  const allowed = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    "get-meeting-tasks",
  );
  if (allowed instanceof Response) return allowed;

  return Response.json({
    meeting_id: meeting.id,
    status: meeting.status,
    can_manage_tasks: allowed,
  });
}));

