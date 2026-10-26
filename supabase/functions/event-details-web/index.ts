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
    .select("id, date, groups!inner(id, number, description, cities(name))")
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
  });
}));
