import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { readMeetingIdParam } from "../_shared/meeting.ts";
import { requireRole } from "../_shared/role.ts";

type EventRow = {
  id: string;
  date: string;
  groups: {
    id: string;
    number: number;
    description: string;
    cities: { name: string };
  };
  books: {
    id: string;
    name: string;
    author: string;
    photos: { url: string } | null;
  } | null;
  locations: { name: string; address: string | null } | null;
  host: {
    users: {
      id: string;
      name: string;
      photos: { url: string } | null;
    } | null;
  } | null;
};

// Detalhes de um evento (encontro) no painel web. Query string: eventId.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const eventId = readMeetingIdParam(new URL(req.url), "eventId");
  if (eventId instanceof Response) return eventId;

  // Rascunho sem data fica fora: o painel trata como evento não encontrado.
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, date, groups!inner(id, number, description, cities(name)), books(id, name, author, photos(url)), locations(name, address), host:group_users!meetings_host_id_fkey(users(id, name, photos(url)))",
    )
    .eq("id", eventId)
    .not("date", "is", null)
    .maybeSingle();

  if (error) {
    console.error("event-details-web error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json(
      { error: { code: "EVENT_NOT_FOUND", message: "Evento não encontrado." } },
      { status: 404 },
    );
  }

  const event = data as unknown as EventRow;

  // Objeto fácil de estender: as CLU-204 a 207 acrescentam blocos aqui.
  return Response.json({
    id: event.id,
    startsAt: event.date,
    group: {
      id: event.groups.id,
      name: `Grupo ${String(event.groups.number).padStart(2, "0")} — ${event.groups.description}`,
      city: event.groups.cities.name,
    },
    book: event.books
      ? {
        id: event.books.id,
        title: event.books.name,
        author: event.books.author,
        coverUrl: event.books.photos?.url ?? null,
      }
      : null,
    location: event.locations
      ? {
        name: event.locations.name,
        address: event.locations.address ?? null,
      }
      : null,
    host: event.host?.users
      ? {
        id: event.host.users.id,
        name: event.host.users.name,
        photoUrl: event.host.users.photos?.url ?? null,
      }
      : null,
  });
}));
