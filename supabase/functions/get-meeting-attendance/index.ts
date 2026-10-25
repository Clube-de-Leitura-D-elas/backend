import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupMember } from "../_shared/group.ts";
import { findMeetingGroupId, readMeetingIdParam } from "../_shared/meeting.ts";

type AttendanceRow = {
  user_id: string;
  invitation_status: string | null;
  presence_status: string | null;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  // The mobile client invokes Edge Functions with POST by default. This
  // endpoint is read-only, so both methods are safe and keep the app contract
  // compatible with the existing Supabase service.
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

  const groupId = await findMeetingGroupId(
    ctx,
    meetingId,
    "get-meeting-attendance",
  );
  if (groupId instanceof Response) return groupId;

  const denied = await requireGroupMember(ctx, groupId);
  if (denied) return denied;

  const { data: participants, error: participantsError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("id, user_id, users!inner(name, photos(url))")
    .eq("group_id", groupId);

  if (participantsError) {
    console.error(
      "get-meeting-attendance participants error",
      participantsError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to load meeting attendance" }, {
      status: 500,
    });
  }

  const { data: attendance, error: attendanceError } = await ctx
    .supabaseAdmin
    .from("meeting_users")
    .select("user_id, invitation_status, presence_status")
    .eq("meeting_id", meetingId);

  if (attendanceError) {
    console.error(
      "get-meeting-attendance attendance error",
      attendanceError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to load meeting attendance" }, {
      status: 500,
    });
  }

  const attendanceByUser = new Map(
    ((attendance ?? []) as unknown as AttendanceRow[]).map((row) => [
      row.user_id,
      row,
    ]),
  );

  const attendees = (participants ?? [])
    .map((row) => {
      const participant = row as unknown as {
        id: string;
        user_id: string;
        users: { name: string; photos: { url: string } | null };
      };
      const record = attendanceByUser.get(participant.user_id);
      return {
        id: participant.id,
        name: participant.users.name,
        photo_url: participant.users.photos?.url ?? null,
        invitation_status: record?.invitation_status ?? "PENDING",
        presence_status: record?.presence_status ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return Response.json({ attendees });
}));