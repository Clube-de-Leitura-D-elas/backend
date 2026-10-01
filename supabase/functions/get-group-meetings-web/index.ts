import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam, requireExistingGroup } from "../_shared/group.ts";
import { readNeighborhood } from "../_shared/location.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { isPresent } from "../_shared/presence.ts";
import { requireRole } from "../_shared/role.ts";

type MeetingRow = {
  id: string;
  date: string;
  books: { name: string; author: string };
  locations: { name: string; address: string } | null;
};

type PresenceRow = {
  meeting_id: string;
  presence_status: string | null;
};

type ReviewRow = {
  meeting_id: string;
  book_rating: number;
};

const roundRating = (sum: number, count: number) =>
  Math.round((sum / count) * 100) / 100;

// Aba "Histórico de Encontros" da tela de detalhes do grupo (painel web).
// Query string: groupId, page, pageSize.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const url = new URL(req.url);
  const groupId = readGroupIdParam(url, "groupId");
  if (groupId instanceof Response) return groupId;

  const missing = await requireExistingGroup(ctx, groupId);
  if (missing) return missing;

  const { from, to } = parseListParams(url);

  // Histórico = encontros já realizados, do mais recente para o mais antigo.
  const { data, error, count } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, date, books!inner(name, author), locations(name, address)",
      { count: "exact" },
    )
    .eq("group_id", groupId)
    .eq("status", "CONCLUDED")
    .not("date", "is", null)
    .order("date", { ascending: false })
    .order("id")
    .range(from, to);

  if (error) {
    console.error("get-group-meetings-web error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 400 });
  }

  const rows = (data ?? []) as unknown as MeetingRow[];
  const total = count ?? 0;

  if (rows.length === 0) {
    return Response.json({ items: [], total });
  }

  const meetingIds = rows.map((meeting) => meeting.id);

  const [presenceResult, reviewsResult] = await Promise.all([
    ctx.supabaseAdmin
      .from("meeting_group_users")
      .select("meeting_id, presence_status")
      .in("meeting_id", meetingIds),

    ctx.supabaseAdmin
      .from("book_reviews")
      .select("meeting_id, book_rating")
      .in("meeting_id", meetingIds),
  ]);

  const detailError = presenceResult.error ?? reviewsResult.error;

  if (detailError) {
    console.error(
      "get-group-meetings-web details error",
      oneLine(detailError.message),
    );
    return Response.json({ error: detailError.message }, { status: 400 });
  }

  // "24 / 26 (92%)": presentes sobre quem teve presença registrada no encontro.
  const attendance = new Map<string, { present: number; total: number }>();

  for (const row of (presenceResult.data ?? []) as unknown as PresenceRow[]) {
    const tally = attendance.get(row.meeting_id) ?? { present: 0, total: 0 };
    tally.total += 1;
    if (isPresent(row.presence_status)) tally.present += 1;
    attendance.set(row.meeting_id, tally);
  }

  const ratings = new Map<string, { sum: number; count: number }>();

  for (const row of (reviewsResult.data ?? []) as unknown as ReviewRow[]) {
    const tally = ratings.get(row.meeting_id) ?? { sum: 0, count: 0 };
    tally.sum += row.book_rating;
    tally.count += 1;
    ratings.set(row.meeting_id, tally);
  }

  const items = rows.map((meeting) => {
    const tally = attendance.get(meeting.id);
    const rating = ratings.get(meeting.id);

    return {
      id: meeting.id,
      date: meeting.date,
      book_title: meeting.books.name,
      book_author: meeting.books.author,
      place: meeting.locations?.name ?? null,
      neighborhood: readNeighborhood(meeting.locations?.address),
      attendance_present: tally?.present ?? 0,
      attendance_total: tally?.total ?? 0,
      average_rating: rating ? roundRating(rating.sum, rating.count) : null,
      votes_count: rating?.count ?? 0,
    };
  });

  return Response.json({ items, total });
}));
