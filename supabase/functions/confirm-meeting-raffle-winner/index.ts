import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupMemberProfile } from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import {
  badRequest,
  hasRaffleResult,
  loadRaffleCandidates,
  pickEligible,
  raffleAlreadyRecorded,
  readJsonBody,
  readMeetingId,
  toResultJson,
} from "../_shared/raffle.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "confirm-meeting-raffle-winner";
const UNIQUE_VIOLATION = "23505";
const SUGGESTION_UNAVAILABLE = "P0048";
const BOOK_ALREADY_DRAWN = "P0049";

// Grava o resultado. Só o winner_id vale: livro, nome e data saem do servidor.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const meetingId = readMeetingId(body);
  if (meetingId instanceof Response) return meetingId;
  const winnerId = body.winner_id;
  if (!isUuid(winnerId)) return badRequest('missing/invalid "winner_id"');

  const meeting = await requireMeetingRecordManager(ctx, meetingId, LOG_LABEL);
  if (meeting instanceof Response) return meeting;

  const member = await requireGroupMemberProfile(ctx, meeting.groupId, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

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

  const picked = pickEligible(candidates, [winnerId.toLowerCase()]);
  if (picked instanceof Response) return picked;
  const winner = picked[0];

  const { data, error } = await ctx.supabaseAdmin.rpc("record_meeting_raffle", {
    p_meeting_id: meetingId,
    p_winner_user_id: winner.userId,
    p_book_suggestion_id: winner.book!.suggestionId,
    p_book_id: winner.book!.bookId,
    p_drawn_by: member.profileId,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return raffleAlreadyRecorded();
    if (error.code === SUGGESTION_UNAVAILABLE) {
      return Response.json({ error: "book suggestion is no longer available" }, {
        status: 409,
      });
    }
    if (error.code === BOOK_ALREADY_DRAWN) {
      return Response.json({ error: "book already drawn in this group" }, {
        status: 409,
      });
    }
    console.error(`${LOG_LABEL} error`, oneLine(error.message));
    return Response.json({ error: "Unable to record raffle result" }, {
      status: 500,
    });
  }

  const drawnAt = (data as { drawn_at: string }).drawn_at;
  return Response.json(toResultJson(meetingId, winner, drawnAt), {
    status: 201,
  });
}));
