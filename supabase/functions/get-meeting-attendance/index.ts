import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupMember } from "../_shared/group.ts";
import { findMeetingGroupId, readMeetingIdParam } from "../_shared/meeting.ts";

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
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

  const { data: groupUsers, error: usersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select(`
      user_id,
      users!inner(name, photos(url))
    `)
    .eq("group_id", groupId);

  if (usersError) {
    console.error(
      "get-meeting-attendance users error",
      usersError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to load meeting attendance" }, {
      status: 500,
    });
  }

  const { data: attendance, error: attendanceError } = await ctx.supabaseAdmin
    .from("meeting_group_users")
    .select(`
      group_user_id,
      invitation_status,
      presence_status,
      group_users!inner(
        user_id
      )
    `)
    .eq("meeting_id", meetingId);

  if (attendanceError) {
    console.error(
      "get-meeting-attendance attendance error",
      attendanceError.message.replace(/[\r\n]/g, " "),
    );

    return Response.json(
      { error: "Unable to load meeting attendance" },
      { status: 500 },
    );
  }

  type MeetingAttendanceRow = {
    group_users: {
      user_id: string;
    };
    invitation_status: "PENDING" | "CONFIRMED" | "DECLINED";
    presence_status: "PRESENT" | "ABSENT" | null;
  };

  const attendanceRows =
    (attendance ?? []) as unknown as MeetingAttendanceRow[];

  const invitationMap = new Map(
    attendanceRows.map((row) => [
      row.group_users.user_id,
      row.invitation_status,
    ]),
  );

  const presenceMap = new Map(
    attendanceRows.map((row) => [
      row.group_users.user_id,
      row.presence_status,
    ]),
  );

  const attendanceList = (groupUsers ?? []).map((row: any) => {
    return {
      id: row.user_id,
      name: row.users?.name ?? "",
      photo_url: row.users?.photos?.url ?? null,
      invitation_status: invitationMap.get(row.user_id) ?? "PENDING",
      presence_status: presenceMap.get(row.user_id) ?? null,
    };
  });

  return Response.json(attendanceList);
}));
