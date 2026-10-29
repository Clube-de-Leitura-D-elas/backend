import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "set-meeting-presence";
const ENDABLE_STATUSES = ["SCHEDULED", "IN_PROGRESS"];

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
};

type ParticipantRow = { user_id: string };

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: { meeting_id?: unknown; present_user_ids?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  const presentIds = body?.present_user_ids;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }
  if (!Array.isArray(presentIds) || !presentIds.every((id) => isUuid(id))) {
    return Response.json({ error: 'missing/invalid "present_user_ids"' }, {
      status: 400,
    });
  }
  const present = new Set<string>(presentIds);

  const { data: meetingData, error: meetingError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, group_id, host_id, status")
    .eq("id", meetingId)
    .maybeSingle();

  if (meetingError) {
    console.error(`${LOG_LABEL} meeting error`, oneLine(meetingError.message));
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }
  if (!meetingData) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const meeting = meetingData as unknown as MeetingRow;

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
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ENDABLE_STATUSES.includes(meeting.status) && meeting.status !== "ENDED") {
    return Response.json(
      { error: "Meeting cannot register presence in its current status" },
      { status: 409 },
    );
  }

  const { data: participantData, error: participantsError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("user_id")
    .eq("group_id", meeting.group_id)
    .eq("registration_status", "ACTIVE");

  if (participantsError) {
    console.error(
      `${LOG_LABEL} participants error`,
      oneLine(participantsError.message),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }

  const participants = (participantData ?? []) as unknown as ParticipantRow[];
  const participantUserIds = new Set(participants.map((p) => p.user_id));
  if (![...present].every((id) => participantUserIds.has(id))) {
    return Response.json({ error: '"present_user_ids" has non-participants' }, {
      status: 400,
    });
  }

  const { count: registeredCount, error: registeredError } = await ctx
    .supabaseAdmin
    .from("meeting_users")
    .select("user_id", { count: "exact", head: true })
    .eq("meeting_id", meeting.id)
    .not("presence_status", "is", null);

  if (registeredError) {
    console.error(
      `${LOG_LABEL} registered error`,
      oneLine(registeredError.message),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }
  if ((registeredCount ?? 0) > 0) {
    return Response.json({ error: "Presence already registered" }, {
      status: 409,
    });
  }

  const rows = participants.map((p) => ({
    meeting_id: meeting.id,
    user_id: p.user_id,
    presence_status: present.has(p.user_id) ? "PRESENT" : "ABSENT",
  }));

  if (rows.length > 0) {
    const { error: upsertError } = await ctx.supabaseAdmin
      .from("meeting_users")
      .upsert(rows, { onConflict: "meeting_id,user_id" });

    if (upsertError) {
      console.error(`${LOG_LABEL} upsert error`, oneLine(upsertError.message));
      return Response.json({ error: "Unable to set presence" }, {
        status: 500,
      });
    }
  }

  // Registrar a presença encerra o encontro (-> ENDED). Ele só passa a
  // CONCLUDED quando a foto oficial é enviada (ver add-meeting-photo).
  if (ENDABLE_STATUSES.includes(meeting.status)) {
    const { error: concludeError } = await ctx.supabaseAdmin
      .from("meetings")
      .update({ status: "ENDED" })
      .eq("id", meeting.id)
      .in("status", ENDABLE_STATUSES);

    if (concludeError) {
      console.error(
        `${LOG_LABEL} conclude error`,
        oneLine(concludeError.message),
      );
      return Response.json({ error: "Unable to conclude meeting" }, {
        status: 500,
      });
    }
  }

  return Response.json({ meeting_id: meeting.id });
}));
