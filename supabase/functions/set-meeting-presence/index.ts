import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { isUuid } from "../_shared/uuid.ts";

type MembershipRow = { id: string; is_coordinator: boolean };
type ParticipantRow = { user_id: string };

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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
  const present = new Set<string>(presentIds as string[]);

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(
      "set-meeting-presence profile error",
      profileError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: meeting, error: meetingError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, group_id, host_id")
    .eq("id", meetingId)
    .maybeSingle();

  if (meetingError) {
    console.error(
      "set-meeting-presence meeting error",
      meetingError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }
  if (!meeting) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const { data: membershipData, error: membershipError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("id, is_coordinator")
    .eq("group_id", meeting.group_id)
    .eq("user_id", profile.id)
    .maybeSingle();

  if (membershipError) {
    console.error(
      "set-meeting-presence membership error",
      membershipError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }
  const membership = membershipData as unknown as MembershipRow | null;
  if (!membership) {
    return Response.json({ error: "Meeting not available" }, { status: 404 });
  }

  const canRegister = membership.is_coordinator ||
    membership.id === meeting.host_id;
  if (!canRegister) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: participantData, error: participantsError } = await ctx
    .supabaseAdmin
    .from("group_users")
    .select("id, user_id")
    .eq("group_id", meeting.group_id);

  if (participantsError) {
    console.error(
      "set-meeting-presence participants error",
      participantsError.message.replace(/[\r\n]/g, " "),
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
      "set-meeting-presence registered error",
      registeredError.message.replace(/[\r\n]/g, " "),
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

  const { error: upsertError } = await ctx.supabaseAdmin
    .from("meeting_users")
    .upsert(rows, { onConflict: "meeting_id,user_id" });

  if (upsertError) {
    console.error(
      "set-meeting-presence upsert error",
      upsertError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to set presence" }, { status: 500 });
  }

  return Response.json({ meeting_id: meeting.id });
}));