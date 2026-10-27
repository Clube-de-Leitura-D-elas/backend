import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "./group.ts";
import { oneLine } from "./log.ts";
import {
  canRecord,
  firstRecord,
  type RecordRow,
  type RecordStatus,
  recordStatus,
} from "./meetingTasks.ts";

/** O encontro, o registro dele e o que a pessoa que chamou pode fazer. */
export type MeetingMaterial = {
  meetingId: string;
  groupId: string;
  profileId: string;
  isConcluded: boolean;
  /** Coordenadora do grupo ou anfitriã do encontro. */
  canManage: boolean;
  /** O encontro já começou (ou encerrou): fotos e resumo liberados. */
  canRecord: boolean;
  /** Já existe linha em `meeting_records`. */
  hasRecord: boolean;
  isPublished: boolean;
  summary: string;
  recordStatus: RecordStatus;
};

type MaterialRecordRow = RecordRow & { summary: string };

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
  date: string | null;
  location_id: string | null;
  meeting_records: MaterialRecordRow | MaterialRecordRow[] | null;
};

export async function loadMeetingMaterial(
  ctx: SupabaseContext<Database>,
  meetingId: string,
  logLabel: string,
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<MeetingMaterial | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, host_id, status, date, location_id, meeting_records(summary, published_at)",
    )
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(`${logLabel} meeting error`, oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  const member = await requireGroupMemberProfile(ctx, meeting.group_id, {
    activeOnly,
  });
  if (member instanceof Response) return member;

  const canManage = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    logLabel,
  );
  if (canManage instanceof Response) return canManage;

  const record = firstRecord(meeting.meeting_records) as
    | MaterialRecordRow
    | null;

  return {
    meetingId: meeting.id,
    groupId: meeting.group_id,
    profileId: member.profileId,
    isConcluded: meeting.status === "CONCLUDED",
    canManage,
    canRecord: canRecord(meeting),
    hasRecord: record !== null,
    isPublished: record?.published_at != null,
    summary: record?.summary ?? "",
    recordStatus: recordStatus(meeting, record),
  };
}

/** Rascunho só aparece para quem gerencia; publicado aparece para o grupo. */
export function canSeeMaterial(material: MeetingMaterial): boolean {
  return material.canManage || material.isPublished;
}

/** Quem gerencia pode mexer nas fotos e no resumo depois que o encontro começa. */
export function canEditMaterial(material: MeetingMaterial): boolean {
  return material.canManage && material.canRecord;
}

export function forbiddenForMembers(): Response {
  return Response.json({
    error: "Forbidden: group coordinators or meeting host only.",
  }, { status: 403 });
}

export function meetingNotStarted(): Response {
  return Response.json({ error: "meeting has not started yet" }, {
    status: 409,
  });
}