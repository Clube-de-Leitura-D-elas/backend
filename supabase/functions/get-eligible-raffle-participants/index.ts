import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupCoordinator } from "../_shared/group.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  hasOpenMeeting,
  hasRaffleResult,
  loadInauguralCandidates,
  loadRaffleCandidates,
  meetingAlreadyOpen,
  raffleAlreadyRecorded,
  readJsonBody,
  readRaffleTarget,
  toParticipantJson,
} from "../_shared/raffle.ts";

const LOG_LABEL = "get-eligible-raffle-participants";

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const target = readRaffleTarget(body);
  if (target instanceof Response) return target;

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

    return Response.json(candidates.map(toParticipantJson));
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

  return Response.json(candidates.map(toParticipantJson));
}));
