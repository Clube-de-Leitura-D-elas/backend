import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";
import type { AppRole } from "../_shared/role.ts";

const LOG_LABEL = "get-participant-presence-history";

const ADMIN_ROLES: readonly AppRole[] = ["MANAGER", "FOUNDER"];

const HELD_MEETING_STATUSES = ["ENDED", "CONCLUDED"];

type MembershipRow = {
  group_id: string;
  groups: { number: number };
};

type MeetingRow = {
  id: string;
  group_id: string;
  date: string;
  books: { name: string };
  meeting_users: { presence_status: "PRESENT" | "ABSENT" | null }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const requestedId = url.searchParams.has("participant_id")
    ? readParticipantIdParam(url)
    : null;
  if (requestedId instanceof Response) return requestedId;

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id, is_active, app_role")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(`${LOG_LABEL} profile error`, oneLine(profileError.message));
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const participantId = requestedId ?? profile.id;
  const isSelf = participantId === profile.id;
  const isAdmin = profile.is_active &&
    ADMIN_ROLES.includes(profile.app_role as AppRole);

  if (!isSelf && isAdmin) {
    const { data: participant, error: participantError } = await ctx
      .supabaseAdmin
      .from("users")
      .select("id")
      .eq("id", participantId)
      .maybeSingle();

    if (participantError) {
      console.error(
        `${LOG_LABEL} participant error`,
        oneLine(participantError.message),
      );
      return serverError();
    }
    if (!participant) {
      return Response.json({ error: "participant not found" }, {
        status: 404,
      });
    }
  }

  const { data: membershipData, error: membershipError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("group_id, groups!inner(number)")
    .eq("user_id", participantId)
    .neq("registration_status", "PENDING");

  if (membershipError) {
    console.error(
      `${LOG_LABEL} membership error`,
      oneLine(membershipError.message),
    );
    return serverError();
  }

  let memberships = (membershipData ?? []) as unknown as MembershipRow[];

  if (!isSelf && !isAdmin) {
    if (!profile.is_active || memberships.length === 0) return forbidden();

    const { data: coordinated, error: coordinatorError } = await ctx
      .supabaseAdmin
      .from("group_users")
      .select("group_id")
      .eq("user_id", profile.id)
      .eq("registration_status", "ACTIVE")
      .eq("is_coordinator", true)
      .in("group_id", memberships.map((row) => row.group_id));

    if (coordinatorError) {
      console.error(
        `${LOG_LABEL} coordinator error`,
        oneLine(coordinatorError.message),
      );
      return serverError();
    }

    const coordinatedIds = new Set(
      (coordinated ?? []).map((row) => row.group_id),
    );
    memberships = memberships.filter((row) => coordinatedIds.has(row.group_id));
    if (memberships.length === 0) return forbidden();
  }

  const meetingsByGroup = new Map<string, MeetingRow[]>();

  if (memberships.length > 0) {
    const { data: meetingData, error: meetingsError } = await ctx
      .supabaseAdmin
      .from("meetings")
      .select(
        "id, group_id, date, books!inner(name), meeting_users(presence_status)",
      )
      .in("group_id", memberships.map((row) => row.group_id))
      .in("status", HELD_MEETING_STATUSES)
      .not("date", "is", null)
      .eq("meeting_users.user_id", participantId)
      .order("date", { ascending: false })
      .order("id");

    if (meetingsError) {
      console.error(
        `${LOG_LABEL} meetings error`,
        oneLine(meetingsError.message),
      );
      return serverError();
    }

    for (const meeting of (meetingData ?? []) as unknown as MeetingRow[]) {
      const list = meetingsByGroup.get(meeting.group_id) ?? [];
      list.push(meeting);
      meetingsByGroup.set(meeting.group_id, list);
    }
  }

  const groups = memberships
    .map((row) => ({
      group_id: row.group_id,
      group_number: row.groups.number,
      meetings: (meetingsByGroup.get(row.group_id) ?? []).map((meeting) => ({
        meeting_id: meeting.id,
        date: meeting.date,
        book_title: meeting.books.name,
        presence_status: meeting.meeting_users[0]?.presence_status ?? null,
      })),
    }))
    .sort((a, b) => a.group_number - b.group_number);

  return Response.json({ participant_id: participantId, groups });
}));

function forbidden(): Response {
  return Response.json({
    error: "Forbidden: own history, admins or group coordinators only.",
  }, { status: 403 });
}

function serverError(): Response {
  return Response.json({ error: "Unable to load presence history" }, {
    status: 500,
  });
}
