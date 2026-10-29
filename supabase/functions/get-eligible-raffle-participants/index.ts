import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  loadRaffleCandidates,
  readJsonBody,
  readMeetingId,
  toParticipantJson,
} from "../_shared/raffle.ts";

const LOG_LABEL = "get-eligible-raffle-participants";

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const meetingId = readMeetingId(body);
  if (meetingId instanceof Response) return meetingId;

  const meeting = await requireMeetingRecordManager(ctx, meetingId, LOG_LABEL);
  if (meeting instanceof Response) return meeting;

  const candidates = await loadRaffleCandidates(
    ctx,
    meetingId,
    meeting.groupId,
    LOG_LABEL,
  );
  if (candidates instanceof Response) return candidates;

  return Response.json(candidates.map(toParticipantJson));
}));
