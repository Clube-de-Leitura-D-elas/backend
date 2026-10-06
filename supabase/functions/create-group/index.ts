import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

// Aceita "43" ou "Grupo 43": o campo "Número do grupo" do modal.
const GROUP_NUMBER = /^(?:grupo\s*)?(\d{1,9})$/i;
const UNIQUE_VIOLATION = "23505";

type CityRow = { id: string; name: string };
type ZoneRow = { id: string; name: string; city_id: string };
type GroupRow = {
  id: string;
  number: number;
  description: string;
  city_id: string;
  zone_id: string | null;
  created_at: string;
};

type Location = { cityId: string; zoneId: string | null; description: string };

// Cria um grupo pelo painel web. Body JSON (o formato do modal):
// { name, cityId, coordinatorId? }. `cityId` pode ser uma cidade ou uma zona.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  let body: { name?: unknown; cityId?: unknown; coordinatorId?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const match = typeof body?.name === "string"
    ? GROUP_NUMBER.exec(body.name.trim())
    : null;
  const number = match ? Number(match[1]) : 0;
  if (number < 1) {
    return Response.json({ error: 'missing/invalid "name"' }, { status: 400 });
  }

  const cityId = body?.cityId;
  if (!isUuid(cityId)) {
    return Response.json({ error: 'missing/invalid "cityId"' }, { status: 400 });
  }

  const rawCoordinatorId = body?.coordinatorId;
  const coordinatorId = rawCoordinatorId === undefined ||
      rawCoordinatorId === null || rawCoordinatorId === ""
    ? null
    : rawCoordinatorId;
  if (coordinatorId !== null && !isUuid(coordinatorId)) {
    return Response.json(
      { error: 'invalid "coordinatorId"' },
      { status: 400 },
    );
  }

  const location = await resolveLocation(ctx, cityId);
  if (location instanceof Response) return location;

  if (coordinatorId !== null) {
    const coordinatorError = await checkCoordinator(ctx, coordinatorId);
    if (coordinatorError) return coordinatorError;
  }

  const { data, error } = await ctx.supabaseAdmin.rpc("create_group", {
    p_number: number,
    p_description: location.description,
    p_city_id: location.cityId,
    p_zone_id: location.zoneId,
    p_coordinator_id: coordinatorId,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return Response.json(
        { error: "group number already exists" },
        { status: 409 },
      );
    }
    console.error("create-group error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  const group = data as GroupRow;

  return Response.json(
    {
      id: group.id,
      number: group.number,
      description: group.description,
      cityId: group.city_id,
      zoneId: group.zone_id,
      coordinatorId,
      createdAt: group.created_at,
    },
    { status: 201 },
  );
}));

// O dropdown "Cidade ou Zona" manda um id só: procura primeiro nas cidades e
// depois nas zonas. A descrição do grupo vira o nome do lugar escolhido, que é
// o que a listagem mostra em "Grupo {número} — {descrição}".
async function resolveLocation(
  ctx: SupabaseContext<Database>,
  id: string,
): Promise<Location | Response> {
  const { data: city, error: cityError } = await ctx.supabaseAdmin
    .from("cities")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();

  if (cityError) {
    console.error("create-group city error", oneLine(cityError.message));
    return Response.json({ error: cityError.message }, { status: 500 });
  }
  if (city) {
    const row = city as CityRow;
    return { cityId: row.id, zoneId: null, description: row.name };
  }

  const { data: zone, error: zoneError } = await ctx.supabaseAdmin
    .from("zones")
    .select("id, name, city_id")
    .eq("id", id)
    .maybeSingle();

  if (zoneError) {
    console.error("create-group zone error", oneLine(zoneError.message));
    return Response.json({ error: zoneError.message }, { status: 500 });
  }
  if (!zone) {
    return Response.json({ error: "city or zone not found" }, { status: 404 });
  }

  const row = zone as ZoneRow;
  return { cityId: row.city_id, zoneId: row.id, description: row.name };
}

async function checkCoordinator(
  ctx: SupabaseContext<Database>,
  coordinatorId: string,
): Promise<Response | null> {
  const { data, error } = await ctx.supabaseAdmin
    .from("users")
    .select("id, is_active")
    .eq("id", coordinatorId)
    .maybeSingle();

  if (error) {
    console.error("create-group coordinator error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "coordinator not found" }, { status: 404 });
  }
  if (!data.is_active) {
    return Response.json({ error: "coordinator is inactive" }, { status: 400 });
  }
  return null;
}
