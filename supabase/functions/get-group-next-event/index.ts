import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";

type MeetingRow = {
  id: string;
  date: string;
  status: string;
  locations: { name: string; address: string } | null;
  books: { name: string; photos: { url: string } | null } | null;
  host: { users: { name: string } };
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const { data: group, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-next-event group error",
      groupError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: groupError.message }, { status: 500 });
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  // Próximo evento = encontro ainda não concluído, com data, a partir de agora.
  // Um encontro IN_PROGRESS continua sendo o próximo mesmo com a data já
  // passada (começou há pouco). Rascunhos sem data ficam de fora: não há o que
  // mostrar no campo de data.
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, date, status, locations(name, address), books(name, photos(url)), host:group_users!meetings_host_id_fkey!inner(users!inner(name))",
    )
    .eq("group_id", groupId)
    .in("status", ["CREATED", "SCHEDULED", "IN_PROGRESS"])
    .not("date", "is", null)
    .or(`date.gte.${new Date().toISOString()},status.eq.IN_PROGRESS`)
    .order("date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(
      "get-group-next-event error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ next_event: null });
  }

  const meeting = data as unknown as MeetingRow;

  return Response.json({
    next_event: {
      id: meeting.id,
      date: meeting.date,
      status: meeting.status,
      location_name: meeting.locations?.name ?? null,
      location_address: meeting.locations?.address ?? null,
      host_name: meeting.host.users.name,
      book_title: meeting.books?.name ?? null,
      book_cover_url: meeting.books?.photos?.url ?? null,
    },
  });
}));
