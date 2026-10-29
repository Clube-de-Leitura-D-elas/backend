import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupMember } from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { findMeetingGroupId } from "../_shared/meeting.ts";
import { readJsonBody, readMeetingId } from "../_shared/raffle.ts";

const LOG_LABEL = "get-meeting-raffle-result";

type RaffleRow = {
  meeting_id: string;
  winner_user_id: string;
  drawn_at: string;
  winner: { name: string; photos: { url: string } | null } | null;
  books: {
    name: string;
    author: string | null;
    photos: { url: string } | null;
  } | null;
};

// Qualquer participante do grupo vê o resultado. Sem sorteio, devolve null.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const meetingId = readMeetingId(body);
  if (meetingId instanceof Response) return meetingId;

  const groupId = await findMeetingGroupId(ctx, meetingId, LOG_LABEL);
  if (groupId instanceof Response) return groupId;

  const denied = await requireGroupMember(ctx, groupId);
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin
    .from("meeting_raffles")
    .select(`
      meeting_id,
      winner_user_id,
      drawn_at,
      winner:users!meeting_raffles_winner_user_id_fkey(name, photos(url)),
      books(name, author, photos(url))
    `)
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (error) {
    console.error(`${LOG_LABEL} error`, oneLine(error.message));
    return Response.json({ error: "Unable to load raffle result" }, {
      status: 500,
    });
  }
  if (!data) return Response.json(null);

  const row = data as unknown as RaffleRow;
  return Response.json({
    meeting_id: row.meeting_id,
    winner_id: row.winner_user_id,
    winner_name: row.winner?.name ?? "",
    winner_avatar_url: row.winner?.photos?.url ?? null,
    book_title: row.books?.name ?? "",
    book_author: row.books?.author ?? null,
    book_cover_url: row.books?.photos?.url ?? null,
    drawn_at: row.drawn_at,
  });
}));
