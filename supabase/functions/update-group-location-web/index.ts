import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

// Edita a localização de um grupo no painel web (só fundadora).
// POST { group_id, description, city_id, zone_id | null }
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { group_id: groupId, description, city_id: cityId, zone_id: zoneId } =
    body as Record<string, unknown>;

  if (!isUuid(groupId)) {
    return Response.json({ error: 'missing/invalid "group_id"' }, {
      status: 400,
    });
  }

  if (typeof description !== "string" || !description.trim()) {
    return Response.json({ error: 'missing/invalid "description"' }, {
      status: 400,
    });
  }

  if (!isUuid(cityId)) {
    return Response.json({ error: 'missing/invalid "city_id"' }, {
      status: 400,
    });
  }

  if (zoneId !== null && !isUuid(zoneId)) {
    return Response.json({ error: 'invalid "zone_id"' }, { status: 400 });
  }

  // A zona precisa ser da cidade escolhida; sem isso o grupo fica com uma
  // "Zona Sul" de outra cidade.
  const { data: city, error: cityError } = await ctx.supabaseAdmin
    .from("cities")
    .select("id, zones(id)")
    .eq("id", cityId)
    .maybeSingle();

  if (cityError) {
    console.error(
      "update-group-location city error",
      oneLine(cityError.message),
    );
    return Response.json({ error: cityError.message }, { status: 500 });
  }

  if (!city) {
    return Response.json({ error: "city not found" }, { status: 400 });
  }

  const cityZones = (city.zones ?? []) as { id: string }[];
  if (zoneId !== null && !cityZones.some((zone) => zone.id === zoneId)) {
    return Response.json({ error: "zone does not belong to city" }, {
      status: 400,
    });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("groups")
    .update({
      description: description.trim(),
      city_id: cityId,
      zone_id: zoneId,
    })
    .eq("id", groupId)
    .select("id, description, city_id, zone_id")
    .maybeSingle();

  if (error) {
    console.error("update-group-location error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  return Response.json(data);
}));
