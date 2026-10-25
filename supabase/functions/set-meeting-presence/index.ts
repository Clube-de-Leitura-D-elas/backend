import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { isUuid } from "../_shared/uuid.ts";

type ParticipantRow = { id: string; user_id: string };

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: { meeting_id?: unknown; present_group_user_ids?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  const presentIds = body?.present_group_user_ids;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }
  if (!Array.isArray(presentIds) || !presentIds.every((id) => isUuid(id))) {
    return Response.json(
      { error: 'missing/invalid "present_group_user_ids"' },
      { status: 400 },
    );
  }
  const present = new Set<string>(presentIds as string[]);

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

  // Coordenadora do grupo ou anfitriã do encontro (mesma regra do
  // can_register_presence da get-meeting-details).
  const member = await requireGroupMemberProfile(ctx, meeting.group_id);
  if (member instanceof Response) return member;

  const allowed = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    "set-meeting-presence",
  );
  if (allowed instanceof Response) return allowed;
  if (!allowed) {
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
  const participantIds = new Set(participants.map((p) => p.id));
  if (![...present].every((id) => participantIds.has(id))) {
    return Response.json(
      { error: '"present_group_user_ids" has non-participants' },
      { status: 400 },
    );
  }

  // Registro fechado: alguma participante do grupo já tem presença gravada.
  // (Convidadas de outros grupos também vivem em meeting_users e não contam.)
  const { count: registeredCount, error: registeredError } = await ctx
    .supabaseAdmin
    .from("meeting_users")
    .select("user_id", { count: "exact", head: true })
    .eq("meeting_id", meeting.id)
    .in("user_id", participants.map((p) => p.user_id))
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

  // Um único upsert: marcadas = PRESENT, não marcadas = ABSENT.
  // invitation_status não entra no payload, então a confirmação prévia fica intocada.
  const rows = participants.map((p) => ({
    meeting_id: meeting.id,
    user_id: p.user_id,
    presence_status: (present.has(p.id) ? "PRESENT" : "ABSENT") as
      | "PRESENT"
      | "ABSENT",
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