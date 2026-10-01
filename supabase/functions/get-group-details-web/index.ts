import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";
import { readNeighborhood } from "../_shared/location.ts";
import { oneLine } from "../_shared/log.ts";
import { requireManagement } from "../_shared/management.ts";

// `group_users.registration_status` é varchar livre; "ACTIVE" é o único valor
// que o schema e o seed documentam para vínculo ativo.
const ACTIVE_REGISTRATION = "ACTIVE";

// Encontro que ainda vai acontecer. Um IN_PROGRESS continua sendo o próximo
// mesmo com a data já passada (começou há pouco); rascunho sem data fica fora.
const OPEN_STATUSES = ["CREATED", "SCHEDULED", "IN_PROGRESS"];

// "Confirmado" na tela = já tem data e local fechados. CREATED é a pendência.
const CONFIRMED_STATUSES = new Set(["SCHEDULED", "IN_PROGRESS"]);

type GroupRow = {
  id: string;
  number: number;
  description: string;
  active: boolean;
  cities: { name: string } | null;
};

type CoordinatorRow = {
  users: { name: string; email: string };
};

type NextMeetingRow = {
  date: string;
  status: string;
  books: { name: string; author: string };
  locations: { name: string; address: string } | null;
};

// Cabeçalho da tela de detalhes do grupo no painel web: identificação do grupo,
// coordenadora responsável e próximo encontro agendado.
// Query string: groupId.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireManagement(ctx);
  if (denied) return denied;

  const groupId = readGroupIdParam(new URL(req.url), "groupId");
  if (groupId instanceof Response) return groupId;

  const { data: groupData, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id, number, description, active, cities(name)")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-details-web group error",
      oneLine(groupError.message),
    );
    return Response.json({ error: groupError.message }, { status: 500 });
  }

  if (!groupData) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  const group = groupData as unknown as GroupRow;

  const [countResult, coordinatorResult, meetingResult] = await Promise.all([
    // "N participantes ativas" do subtítulo: vínculo ativo e conta ativa.
    ctx.supabaseAdmin
      .from("group_users")
      .select("id, users!inner(is_active)", { count: "exact", head: true })
      .eq("group_id", groupId)
      .eq("registration_status", ACTIVE_REGISTRATION)
      .eq("users.is_active", true),

    ctx.supabaseAdmin
      .from("group_users")
      .select("users!inner(name, email)")
      .eq("group_id", groupId)
      .eq("is_coordinator", true)
      .order("id")
      .limit(1)
      .maybeSingle(),

    ctx.supabaseAdmin
      .from("meetings")
      .select(
        "date, status, books!inner(name, author), locations(name, address)",
      )
      .eq("group_id", groupId)
      .in("status", OPEN_STATUSES)
      .not("date", "is", null)
      .or(`date.gte.${new Date().toISOString()},status.eq.IN_PROGRESS`)
      .order("date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const error = countResult.error ?? coordinatorResult.error ??
    meetingResult.error;

  if (error) {
    console.error(
      "get-group-details-web details error",
      oneLine(error.message),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  const coordinator = coordinatorResult.data as unknown as
    | CoordinatorRow
    | null;
  const meeting = meetingResult.data as unknown as NextMeetingRow | null;

  return Response.json({
    id: group.id,
    number: group.number,
    description: group.description,
    city: group.cities?.name ?? null,
    is_active: group.active,
    active_participants_count: countResult.count ?? 0,
    coordinator_name: coordinator?.users.name ?? null,
    coordinator_email: coordinator?.users.email ?? null,
    next_meeting: meeting
      ? {
        date: meeting.date,
        book_title: meeting.books.name,
        book_author: meeting.books.author,
        place: meeting.locations?.name ?? null,
        neighborhood: readNeighborhood(meeting.locations?.address),
        confirmed: CONFIRMED_STATUSES.has(meeting.status),
      }
      : null,
  });
}));
