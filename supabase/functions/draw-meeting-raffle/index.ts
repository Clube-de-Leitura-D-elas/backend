import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  hasRaffleResult,
  loadRaffleCandidates,
  pickEligible,
  raffleAlreadyRecorded,
  randomIndex,
  readJsonBody,
  readMeetingId,
  readParticipantIds,
  toResultJson,
} from "../_shared/raffle.ts";

const LOG_LABEL = "draw-meeting-raffle";

// Sorteia no servidor, sem gravar: o resultado só vale depois da
// confirm-meeting-raffle-winner, o que permite o "Sortear novamente".
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const meetingId = readMeetingId(body);
  if (meetingId instanceof Response) return meetingId;
  const ids = readParticipantIds(body);
  if (ids instanceof Response) return ids;

  const meeting = await requireMeetingRecordManager(ctx, meetingId, LOG_LABEL);
  if (meeting instanceof Response) return meeting;

  const recorded = await hasRaffleResult(ctx, meetingId, LOG_LABEL);
  if (recorded instanceof Response) return recorded;
  if (recorded) return raffleAlreadyRecorded();

  const candidates = await loadRaffleCandidates(
    ctx,
    req,
    meetingId,
    meeting.groupId,
    LOG_LABEL,
  );
  if (candidates instanceof Response) return candidates;

  const eligible = pickEligible(candidates, ids);
  if (eligible instanceof Response) return eligible;

  const winner = eligible[randomIndex(eligible.length)];
  return Response.json(toResultJson(meetingId, winner, null));
}));
