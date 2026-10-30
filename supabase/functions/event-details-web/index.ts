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

type ParticipantRow = {
  user_id: string;
  users: { name: string; photos: { url: string } | null };
};

type AttendanceRow = ParticipantRow & { presence_status: string | null };

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

  const { data: groupUsers, error: groupUsersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("user_id, users!inner(name, photos(url))")
    .eq("group_id", event.groups.id)
    .eq("registration_status", "ACTIVE");

  if (groupUsersError) {
    console.error(
      "event-details-web participants error",
      oneLine(groupUsersError.message),
    );
    return Response.json({ error: groupUsersError.message }, { status: 500 });
  }

  const { data: attendanceRows, error: attendanceError } = await ctx
    .supabaseAdmin
    .from("meeting_users")
    .select("user_id, presence_status, users!inner(name, photos(url))")
    .eq("meeting_id", event.id);

  if (attendanceError) {
    console.error(
      "event-details-web attendance error",
      oneLine(attendanceError.message),
    );
    return Response.json({ error: attendanceError.message }, { status: 500 });
  }

  // Participantes ativas do grupo + quem tem presença registrada no encontro
  // (convidadas e quem saiu do grupo depois de participar).
  const rowsByUser = new Map<string, ParticipantRow>();
  for (const row of groupUsers as unknown as ParticipantRow[]) {
    rowsByUser.set(row.user_id, row);
  }

  const presenceByUser = new Map<string, string>();
  for (const row of attendanceRows as unknown as AttendanceRow[]) {
    if (!row.presence_status) continue;
    presenceByUser.set(row.user_id, row.presence_status);
    if (!rowsByUser.has(row.user_id)) rowsByUser.set(row.user_id, row);
  }

  const participants = [...rowsByUser.values()]
    .map((row) => {
      const status = presenceByUser.get(row.user_id);
      return {
        id: row.user_id,
        name: row.users.name,
        photoUrl: row.users.photos?.url ?? null,
        // sem registro de presença fica nulo
        attended: status ? status === "PRESENT" : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  // Objeto fácil de estender: as CLU-207 e seguintes acrescentam blocos aqui.
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
    attendance: {
      present: participants.filter((p) => p.attended === true).length,
      absent: participants.filter((p) => p.attended === false).length,
      total: participants.length,
    },
    participants,
  });
}));
