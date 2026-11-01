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
  book_id: string;
  books: { name: string; author: string };
  locations: { name: string; address: string } | null;
};

type PresenceRow = {
  meeting_id: string;
  user_id: string;
  presence_status: string | null;
};

type ReviewRow = {
  user_id: string;
  book_id: string;
  rating: number;
};

const roundRating = (sum: number, count: number) =>
  Math.round((sum / count) * 100) / 100;

// Aba "Histórico de Encontros" da tela de detalhes do grupo (painel web).
// Query string: groupId, page, pageSize.
Deno.serve(
  withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
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
        "id, date, book_id, books!inner(name, author), locations(name, address)",
        {
          count: "exact",
        },
      )
      .eq("group_id", groupId)
      .in("status", ["ENDED", "CONCLUDED"])
      .not("date", "is", null)
      .order("date", { ascending: false })
      .order("id")
      .range(from, to);

    if (error) {
      console.error("get-group-meetings-web error", oneLine(error.message));
      return Response.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as unknown as MeetingRow[];
    const total = count ?? 0;

    if (rows.length === 0) {
      return Response.json({ items: [], total });
    }

    const meetingIds = rows.map((meeting) => meeting.id);

    const presenceResult = await ctx.supabaseAdmin
      .from("meeting_users")
      .select("meeting_id, user_id, presence_status")
      .in("meeting_id", meetingIds);

    if (presenceResult.error) {
      console.error(
        "get-group-meetings-web presence error",
        oneLine(presenceResult.error.message),
      );
      return Response.json(
        { error: presenceResult.error.message },
        { status: 500 },
      );
    }

    // "24 / 26 (92%)": presentes sobre quem teve presença registrada no encontro.
    const attendance = new Map<string, { present: number; total: number }>();
    const presentByMeeting = new Map<string, Set<string>>();

    for (const row of (presenceResult.data ?? []) as unknown as PresenceRow[]) {
      const tally = attendance.get(row.meeting_id) ?? { present: 0, total: 0 };
      tally.total += 1;
      if (isPresent(row.presence_status)) {
        tally.present += 1;
        const present = presentByMeeting.get(row.meeting_id) ?? new Set();
        present.add(row.user_id);
        presentByMeeting.set(row.meeting_id, present);
      }
      attendance.set(row.meeting_id, tally);
    }

    // A avaliação é por livro (não há mais book_reviews.meeting_id): a nota do
    // encontro = reviews do livro do encontro feitas por quem esteve presente.
    const bookIds = [...new Set(rows.map((meeting) => meeting.book_id))];
    const presentUserIds = [
      ...new Set([...presentByMeeting.values()].flatMap((set) => [...set])),
    ];

    let reviews: ReviewRow[] = [];

    if (presentUserIds.length > 0) {
      const reviewsResult = await ctx.supabaseAdmin
        .from("book_reviews")
        .select("user_id, book_id, rating")
        .in("book_id", bookIds)
        .in("user_id", presentUserIds);

      if (reviewsResult.error) {
        console.error(
          "get-group-meetings-web reviews error",
          oneLine(reviewsResult.error.message),
        );
        return Response.json(
          { error: reviewsResult.error.message },
          { status: 500 },
        );
      }

      reviews = (reviewsResult.data ?? []) as unknown as ReviewRow[];
    }

    // Os dois `.in` trazem o produto cartesiano (livro de um encontro x
    // presente de outro), então o vínculo review <-> encontro é refeito aqui.
    const ratings = new Map<string, { sum: number; count: number }>();

    for (const meeting of rows) {
      const present = presentByMeeting.get(meeting.id);
      if (!present) continue;

      for (const review of reviews) {
        if (review.book_id !== meeting.book_id) continue;
        if (!present.has(review.user_id)) continue;

        const tally = ratings.get(meeting.id) ?? { sum: 0, count: 0 };
        tally.sum += review.rating;
        tally.count += 1;
        ratings.set(meeting.id, tally);
      }
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
  }),
);
