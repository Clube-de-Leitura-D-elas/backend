import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "./group.ts";
import { findMeetingGroupIdAndHostId } from "./meeting.ts";

// Mesma janela da add-meeting-photo: o registro do encontro (fotos e texto de
// divulgação) só abre depois do encerramento.
export const RECORD_STATUSES = ["ENDED", "CONCLUDED"];

export type RecordMeeting = { groupId: string; hostId: string; status: string };

/**
 * Garante que quem chama pode mexer no registro do encontro: anfitriã ou
 * coordenação ativa do grupo, com o encontro já encerrado.
 * Retorna o encontro, ou uma Response de erro para devolver direto.
 */
export async function requireMeetingRecordManager(
  ctx: SupabaseContext<Database>,
  meetingId: string,
  logLabel: string,
): Promise<RecordMeeting | Response> {
  const meeting = await findMeetingGroupIdAndHostId(ctx, meetingId, logLabel);
  if (meeting instanceof Response) return meeting;

  const member = await requireGroupMemberProfile(ctx, meeting.groupId, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

  const allowed = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.groupId,
    member.profileId,
    meeting.hostId,
    logLabel,
  );
  if (allowed instanceof Response) return allowed;
  if (!allowed) {
    return Response.json({
      error: "Forbidden: group coordinators or meeting host only.",
    }, { status: 403 });
  }

  if (!RECORD_STATUSES.includes(meeting.status)) {
    return Response.json({
      error: "meeting record is only available after the meeting is ended",
    }, { status: 409 });
  }

  return meeting;
}
