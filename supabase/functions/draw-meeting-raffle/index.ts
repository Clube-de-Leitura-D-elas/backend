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
  narrowByHostRotation,
  pickEligible,
  raffleAlreadyRecorded,
  randomIndex,
  readJsonBody,
  readParticipantIds,
  readRaffleTarget,
  toResultJson,
} from "../_shared/raffle.ts";

const LOG_LABEL = "draw-meeting-raffle";

// Sorteia no servidor, sem gravar: o resultado só vale depois da
// confirm-meeting-raffle-winner, o que permite o "Sortear novamente".
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

    // No sorteio inaugural não há bloqueio por rodízio de anfitriãs
    const winner = eligible[randomIndex(eligible.length)];
    return Response.json(
      toResultJson(null, winner, null, null, target.groupId),
    );
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

  // Rodízio de anfitriãs: só entre as marcadas que ele permite.
  const pool = await narrowByHostRotation(
    ctx,
    target.meetingId,
    meeting.groupId,
    LOG_LABEL,
    eligible,
  );
  if (pool instanceof Response) return pool;

  const winner = pool[randomIndex(pool.length)];
  return Response.json(
    toResultJson(target.meetingId, winner, null, null, meeting.groupId),
  );
}));
