import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";

type MembershipRow = {
  id: string;
  groups: {
    id: string;
    number: number;
    cities: { name: string; uf: string } | null;
    photos: { url: string } | null;
  };
};

type MeetingRow = {
  id: string;
  group_id: string;
  date: string;
  locations: { name: string; address: string } | null;
  books: { name: string };
  host: { users: { name: string } };
  meeting_group_users: { group_user_id: string }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (_req, ctx) => {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error("get-my-groups profile error", profileError.message);
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select(
      "id, group_id, groups!inner(id, number, cities(name, uf), photos(url))",
    )
    .eq("user_id", profile.id)
    .eq("groups.active", true)
    .order("group_id");

  if (error) {
    console.error("get-my-groups memberships error", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const memberships = (data ?? []) as unknown as MembershipRow[];
  const groupsById = new Map(
    memberships.map((membership) => [membership.groups.id, membership.groups]),
  );
  const groups = [...groupsById.values()];
  const groupIds = groups.map((group) => group.id);

  if (groupIds.length === 0) {
    return Response.json({ groups: [] });
  }

  const { data: groupUsers, error: groupUsersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("group_id")
    .in("group_id", groupIds);

  if (groupUsersError) {
    console.error(
      "get-my-groups participant count error",
      groupUsersError.message,
    );
    return Response.json({ error: groupUsersError.message }, { status: 500 });
  }

  // Fetch every candidate at once, then retain the first ordered meeting for
  // each group. This applies the same eligibility definition as
  // get-group-next-event without issuing a request for each group.
  const { data: meetingData, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, date, locations(name, address), books!inner(name), host:group_users!meetings_host_id_fkey!inner(users!inner(name)), meeting_group_users(group_user_id)",
    )
    .in("group_id", groupIds)
    .in("status", ["CREATED", "SCHEDULED", "IN_PROGRESS"])
    .not("date", "is", null)
    .or(`date.gte.${new Date().toISOString()},status.eq.IN_PROGRESS`)
    .order("date", { ascending: true });

  if (meetingsError) {
    console.error(
      "get-my-groups next meetings error",
      meetingsError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: meetingsError.message }, { status: 500 });
  }

  const membershipIdByGroupId = new Map(
    memberships.map((membership) => [membership.groups.id, membership.id]),
  );
  const nextMeetingByGroupId = new Map<string, MeetingRow>();
  for (const meeting of (meetingData ?? []) as unknown as MeetingRow[]) {
    if (!nextMeetingByGroupId.has(meeting.group_id)) {
      nextMeetingByGroupId.set(meeting.group_id, meeting);
    }
  }

  const countsByGroupId = new Map<string, number>();
  for (const groupUser of groupUsers ?? []) {
    countsByGroupId.set(
      groupUser.group_id,
      (countsByGroupId.get(groupUser.group_id) ?? 0) + 1,
    );
  }

  return Response.json({
    groups: groups.map((group) => {
      const city = group.cities;
      const meeting = nextMeetingByGroupId.get(group.id);
      const membershipId = membershipIdByGroupId.get(group.id);
      return {
        id: group.id,
        number: group.number,
        participant_count: countsByGroupId.get(group.id) ?? 0,
        city_state: city ? `${city.name}, ${city.uf}` : "",
        photo_url: group.photos?.url ?? null,
        next_meeting: meeting
          ? {
            id: meeting.id,
            host_name: meeting.host.users.name,
            book_title: meeting.books.name,
            date: meeting.date,
            location: meeting.locations?.name ?? "",
          }
          : null,
        has_pending_response: meeting
          ? !meeting.meeting_group_users.some(
            (attendance) => attendance.group_user_id === membershipId,
          )
          : false,
      };
    }),
  });
}));
