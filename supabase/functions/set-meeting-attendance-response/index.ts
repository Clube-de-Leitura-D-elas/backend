import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { isUuid } from "../_shared/uuid.ts";

const ALLOWED_INVITATION_STATUSES = new Set(["CONFIRMED", "DECLINED"]);

type MembershipRow = {
  id: string;
  group_id: string;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { meeting_id?: unknown; invitation_status?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  const invitationStatus = body?.invitation_status;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }
  if (
    typeof invitationStatus !== "string" ||
    !ALLOWED_INVITATION_STATUSES.has(invitationStatus)
  ) {
    return Response.json(
      { error: 'missing/invalid "invitation_status"' },
      { status: 400 },
    );
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(
      "set-meeting-attendance-response profile error",
      profileError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set attendance response" }, {
      status: 500,
    });
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: membershipData, error: membershipsError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("id, group_id")
    .eq("user_id", profile.id);

  if (membershipsError) {
    console.error(
      "set-meeting-attendance-response memberships error",
      membershipsError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set attendance response" }, {
      status: 500,
    });
  }

  const memberships = (membershipData ?? []) as unknown as MembershipRow[];
  if (memberships.length === 0) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const membershipByGroupId = new Map(
    memberships.map((membership) => [membership.group_id, membership]),
  );
  const { data: meeting, error: meetingError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, group_id")
    .eq("id", meetingId)
    .in("group_id", [...membershipByGroupId.keys()])
    .in("status", ["CREATED", "SCHEDULED", "IN_PROGRESS"])
    .not("date", "is", null)
    .or(`date.gte.${new Date().toISOString()},status.eq.IN_PROGRESS`)
    .maybeSingle();

  if (meetingError) {
    console.error(
      "set-meeting-attendance-response meeting error",
      meetingError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set attendance response" }, {
      status: 500,
    });
  }
  if (!meeting) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const membership = membershipByGroupId.get(meeting.group_id);
  if (!membership) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const { data: response, error: responseError } = await ctx.supabaseAdmin
    .from("meeting_group_users")
    .upsert(
      {
        meeting_id: meeting.id,
        group_user_id: membership.id,
        presence_status: "PENDING",
        invitation_status: invitationStatus,
      },
      { onConflict: "meeting_id,group_user_id" },
    )
    .select("meeting_id, invitation_status")
    .single();

  if (responseError) {
    console.error(
      "set-meeting-attendance-response upsert error",
      responseError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set attendance response" }, {
      status: 500,
    });
  }

  return Response.json({
    meeting_id: response.meeting_id,
    invitation_status: response.invitation_status,
  });
}));