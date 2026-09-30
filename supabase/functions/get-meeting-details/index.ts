import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readMeetingIdParam } from "../_shared/meeting.ts";

type MeetingRow = {
  id: string;
  group_id: string;
  date: string | null;
  status: string;
  description: string | null;
  books: { name: string; photos: { url: string } | null };
  locations: { name: string; address: string } | null;
  host: { users: { name: string } };
  meeting_photos: { is_cover: boolean; photos: { url: string } | null }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, date, status, description, books!inner(name, photos(url)), locations(name, address), host:group_users!meetings_host_id_fkey!inner(users!inner(name)), meeting_photos(is_cover, photos(url))",
    )
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(
      "get-meeting-details error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  // "Encontro N": posição do encontro na ordem cronológica dos encontros do
  // grupo que já têm data. Rascunho sem data não tem número.
  let number: number | null = null;
  if (meeting.date) {
    const { count, error: countError } = await ctx.supabaseAdmin
      .from("meetings")
      .select("id", { count: "exact", head: true })
      .eq("group_id", meeting.group_id)
      .not("date", "is", null)
      .lte("date", meeting.date);

    if (countError) {
      console.error(
        "get-meeting-details number error",
        countError.message.replace(/[\r\n]/g, " "),
      );
      return Response.json({ error: countError.message }, { status: 500 });
    }

    number = count ?? null;
  }

  const cover = meeting.meeting_photos.find((photo) => photo.is_cover);
  const description = meeting.description?.trim();

  return Response.json({
    id: meeting.id,
    number,
    date: meeting.date,
    status: meeting.status,
    description: description ? description : null,
    cover_photo_url: cover?.photos?.url ?? null,
    book_title: meeting.books.name,
    book_cover_url: meeting.books.photos?.url ?? null,
    host_name: meeting.host.users.name,
    location_name: meeting.locations?.name ?? null,
    location_address: meeting.locations?.address ?? null,
  });
}));
