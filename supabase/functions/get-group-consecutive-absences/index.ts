import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  readGroupIdParam,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { isPresent } from "../_shared/presence.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

const LOG_LABEL = "get-group-consecutive-absences";

const MIN_CONSECUTIVE_ABSENCES = 3;
const PAGE_SIZE = 500;

type MemberRow = {
  users: {
    id: string;
    name: string;
    photos: { url: string } | null;
  };
};

type PresenceRow = {
  meeting_id: string;
  user_id: string;
  presence_status: string;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const member = await requireGroupMemberProfile(ctx, groupId, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

  const { data: coordinator, error: coordinatorError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", member.profileId)
    .eq("registration_status", "ACTIVE")
    .eq("is_coordinator", true)
    .limit(1)
    .maybeSingle();

  if (coordinatorError) {
    console.error(
      `${LOG_LABEL} coordinator error`,
      oneLine(coordinatorError.message),
    );
    return serverError();
  }
  if (!coordinator) {
    return Response.json({
      error: "Forbidden: group coordinators only.",
    }, { status: 403 });
  }

  const { data: memberData, error: membersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("users!inner(id, name, photos(url))")
    .eq("group_id", groupId)
    .eq("registration_status", "ACTIVE");

  if (membersError) {
    console.error(`${LOG_LABEL} members error`, oneLine(membersError.message));
    return serverError();
  }

  const { data: meetingData, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id")
    .eq("group_id", groupId)
    .in("status", ["ENDED", "CONCLUDED"])
    .not("date", "is", null)
    .order("date", { ascending: false });

  if (meetingsError) {
    console.error(
      `${LOG_LABEL} meetings error`,
      oneLine(meetingsError.message),
    );
    return serverError();
  }

  const members = (memberData ?? []) as unknown as MemberRow[];
  const meetingIds = (meetingData ?? []).map((meeting) => meeting.id);

  const presenceByKey = new Map<string, boolean>();
  if (members.length > 0 && meetingIds.length > 0) {
    for (let offset = 0;; offset += PAGE_SIZE) {
      const { data: presenceData, error: presenceError } = await ctx
        .supabaseAdmin
        .from("meeting_users")
        .select("meeting_id, user_id, presence_status, meetings!inner(id)")
        .eq("meetings.group_id", groupId)
        .in("meetings.status", ["ENDED", "CONCLUDED"])
        .in("user_id", members.map((row) => row.users.id))
        .not("presence_status", "is", null)
        .order("meeting_id")
        .order("user_id")
        .range(offset, offset + PAGE_SIZE - 1);

      if (presenceError) {
        console.error(
          `${LOG_LABEL} presence error`,
          oneLine(presenceError.message),
        );
        return serverError();
      }

      const batch = (presenceData ?? []) as unknown as PresenceRow[];
      for (const row of batch) {
        presenceByKey.set(
          `${row.user_id}:${row.meeting_id}`,
          isPresent(row.presence_status),
        );
      }

      if (batch.length < PAGE_SIZE) break;
    }
  }

  const flagged = members
    .map((row) => ({
      row,
      consecutive_absences: countConsecutiveAbsences(
        row.users.id,
        meetingIds,
        presenceByKey,
      ),
    }))
    .filter((item) => item.consecutive_absences >= MIN_CONSECUTIVE_ABSENCES);

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    flagged.map((item) => item.row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  const participants = flagged
    .map(({ row, consecutive_absences }) => ({
      id: row.users.id,
      name: row.users.name,
      photo_url: resolvePhotoUrl(row.users.photos?.url),
      consecutive_absences,
    }))
    .sort((a, b) =>
      b.consecutive_absences - a.consecutive_absences ||
      a.name.localeCompare(b.name, "pt-BR")
    );

  return Response.json({
    min_consecutive_absences: MIN_CONSECUTIVE_ABSENCES,
    participants,
  });
}));

function countConsecutiveAbsences(
  userId: string,
  meetingIds: string[],
  presenceByKey: Map<string, boolean>,
): number {
  let absences = 0;
  for (const meetingId of meetingIds) {
    const present = presenceByKey.get(`${userId}:${meetingId}`);
    if (present === undefined) continue;
    if (present) break;
    absences += 1;
  }
  return absences;
}

function serverError(): Response {
  return Response.json({ error: "Unable to load consecutive absences" }, {
    status: 500,
  });
}
