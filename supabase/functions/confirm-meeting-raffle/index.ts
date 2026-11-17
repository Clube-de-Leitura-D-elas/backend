import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupCoordinator } from "../_shared/group.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  hasAnyMeeting,
  hasOpenMeeting,
  hasRaffleResult,
  inauguralRaffleUnavailable,
  loadInauguralCandidates,
  loadRaffleCandidates,
  meetingAlreadyOpen,
  pickEligible,
  raffleAlreadyRecorded,
  readJsonBody,
  readParticipantIds,
  readRaffleTarget,
} from "../_shared/raffle.ts";

const LOG_LABEL = "confirm-meeting-raffle";

// Confirma quem entra no sorteio. Não grava nada: a lista vai de novo na
// draw-meeting-raffle, que revalida.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const target = readRaffleTarget(body);
  if (target instanceof Response) return target;
  const ids = readParticipantIds(body);
  if (ids instanceof Response) return ids;

  if (target.type === "inaugural") {
    const coordinatorDenied = await requireGroupCoordinator(
      ctx,
      target.groupId,
      LOG_LABEL,
    );
    if (coordinatorDenied) return coordinatorDenied;

    const openMeeting = await hasOpenMeeting(ctx, target.groupId, LOG_LABEL);
    if (openMeeting instanceof Response) return openMeeting;
    if (openMeeting) return meetingAlreadyOpen();

    const existingMeeting = await hasAnyMeeting(
      ctx,
      target.groupId,
      LOG_LABEL,
    );
    if (existingMeeting instanceof Response) return existingMeeting;
    if (existingMeeting) return inauguralRaffleUnavailable();

    const recorded = await hasRaffleResult(
      ctx,
      { groupId: target.groupId },
      LOG_LABEL,
    );
    if (recorded instanceof Response) return recorded;
    if (recorded) return raffleAlreadyRecorded();

    const candidates = await loadInauguralCandidates(
      ctx,
      req,
      target.groupId,
      LOG_LABEL,
    );
    if (candidates instanceof Response) return candidates;

    const eligible = pickEligible(candidates, ids);
    if (eligible instanceof Response) return eligible;

    return Response.json({
      group_id: target.groupId,
      meeting_id: null,
      eligible_participant_ids: eligible.map((c) => c.userId),
    });
  }

  const meeting = await requireMeetingRecordManager(
    ctx,
    target.meetingId,
    LOG_LABEL,
  );
  if (meeting instanceof Response) return meeting;

  const openMeeting = await hasOpenMeeting(ctx, meeting.groupId, LOG_LABEL);
  if (openMeeting instanceof Response) return openMeeting;
  if (openMeeting) return meetingAlreadyOpen();

  const recorded = await hasRaffleResult(
    ctx,
    { meetingId: target.meetingId },
    LOG_LABEL,
  );
  if (recorded instanceof Response) return recorded;
  if (recorded) return raffleAlreadyRecorded();

  const candidates = await loadRaffleCandidates(
    ctx,
    req,
    target.meetingId,
    meeting.groupId,
    LOG_LABEL,
  );
  if (candidates instanceof Response) return candidates;

  const eligible = pickEligible(candidates, ids);
  if (eligible instanceof Response) return eligible;

  return Response.json({
    meeting_id: target.meetingId,
    group_id: meeting.groupId,
    eligible_participant_ids: eligible.map((c) => c.userId),
  });
}));
