import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";
import { readNeighborhood } from "../_shared/location.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";
import { requireRole } from "../_shared/role.ts";

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
  is_active: boolean;
  cities: { name: string } | null;
  zones: { name: string } | null;
};

type CoordinatorRow = {
  users: {
    id: string;
    name: string;
    email: string;
    photos: { url: string } | null;
  };
};

type NextMeetingRow = {
  date: string;
  status: string;
  books: { name: string; author: string };
  locations: { name: string; address: string } | null;
};

// Cabeçalho da tela de detalhes do grupo no painel web: identificação do grupo,
// coordenadoras e próximo encontro agendado.
// Query string: groupId.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const groupId = readGroupIdParam(new URL(req.url), "groupId");
  if (groupId instanceof Response) return groupId;

  const { data: groupData, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id, number, description, is_active, cities(name), zones(name)")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-details-web group error",
      oneLine(groupError.message),
    );
    return Response.json({ error: "unable to load group" }, { status: 500 });
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

    // Todas as coordenadoras ativas; a ordem estável é aplicada abaixo, porque
    // o `order` do PostgREST não ordena a linha pai pela coluna do embed.
    ctx.supabaseAdmin
      .from("group_users")
      .select("users!inner(id, name, email, photos(url))")
      .eq("group_id", groupId)
      .eq("is_coordinator", true)
      .eq("registration_status", ACTIVE_REGISTRATION)
      .eq("users.is_active", true),

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
    return Response.json({ error: "unable to load group" }, { status: 500 });
  }

  const coordinatorRows = (coordinatorResult.data ?? []) as unknown as
    CoordinatorRow[];
  const meeting = meetingResult.data as unknown as NextMeetingRow | null;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    coordinatorRows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  const coordinators = coordinatorRows
    .toSorted((a, b) =>
      a.users.name.localeCompare(b.users.name, "pt-BR") ||
      a.users.id.localeCompare(b.users.id)
    )
    .map(({ users }) => ({
      id: users.id,
      name: users.name,
      email: users.email,
      photo: resolvePhotoUrl(users.photos?.url),
    }));
  // Campos legados: o painel web em produção ainda lê só uma coordenadora.
  // Saem em PR próprio depois que o web migrar para `coordinators`.
  const firstCoordinator = coordinators[0];

  return Response.json({
    id: group.id,
    number: group.number,
    description: group.description,
    city: group.cities?.name ?? null,
    zone: group.zones?.name ?? null,
    is_active: group.is_active,
    active_participants_count: countResult.count ?? 0,
    coordinators,
    coordinator_name: firstCoordinator?.name ?? null,
    coordinator_email: firstCoordinator?.email ?? null,
    coordinator_photo: firstCoordinator?.photo ?? null,
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
