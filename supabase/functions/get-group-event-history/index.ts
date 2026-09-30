import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";

type MeetingRow = {
  id: string;
  date: string;
  books: { name: string; photos: { url: string } | null };
  host: { users: { name: string } };
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, date, books!inner(name, photos(url)), host:group_users!meetings_host_id_fkey!inner(users!inner(name))",
    )
    .eq("group_id", groupId)
    .eq("status", "CONCLUDED")
    .lte("date", new Date().toISOString())
    .order("date", { ascending: false });

  if (error) {
    console.error(
      "get-group-event-history error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  const meetings = (data ?? []) as unknown as MeetingRow[];
  return Response.json({
    items: meetings.map((meeting) => ({
      id: meeting.id,
      book_title: meeting.books.name,
      book_cover_url: meeting.books.photos?.url ?? null,
      host_name: meeting.host.users.name,
      date: meeting.date,
    })),
  });
}));
