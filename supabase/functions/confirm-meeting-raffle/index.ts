import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  hasRaffleResult,
  loadRaffleCandidates,
  pickEligible,
  raffleAlreadyRecorded,
  readJsonBody,
  readMeetingId,
  readParticipantIds,
} from "../_shared/raffle.ts";

const LOG_LABEL = "confirm-meeting-raffle";

// Confirma quem entra no sorteio. Não grava nada: a lista vai de novo na
// draw-meeting-raffle, que revalida.
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
    meetingId,
    meeting.groupId,
    LOG_LABEL,
  );
  if (candidates instanceof Response) return candidates;

  const eligible = pickEligible(candidates, ids);
  if (eligible instanceof Response) return eligible;

  return Response.json({
    meeting_id: meetingId,
    eligible_participant_ids: eligible.map((c) => c.userId),
  });
}));
