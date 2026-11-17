import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import {
  isUf,
  normalizeLocationName,
  readLocationName,
} from "../_shared/city.ts";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";

const MAX_ZONES = 50;

type ZoneInput = { id: string | null; name: string; is_active: boolean };

type CityInput = {
  cityId: string | null;
  name: string;
  uf: string;
  zones: ZoneInput[];
};

const badRequest = (error: string) => Response.json({ error }, { status: 400 });

function readZones(value: unknown): ZoneInput[] | Response {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ZONES) {
    return badRequest('invalid "zones"');
  }

  const zones: ZoneInput[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return badRequest('invalid "zones"');
    }

    const { id, name, is_active: isActive } = item as Record<string, unknown>;
    const zoneId = id === undefined || id === null ? null : id;
    if (zoneId !== null && !isUuid(zoneId)) {
      return badRequest('invalid zone "id"');
    }
    if (zoneId !== null && ids.has(zoneId)) {
      return badRequest("repeated zone id");
    }

    const zoneName = readLocationName(name);
    if (zoneName === null) return badRequest('invalid zone "name"');

    if (isActive !== undefined && typeof isActive !== "boolean") {
      return badRequest('invalid zone "is_active"');
    }

    const normalizedName = normalizeLocationName(zoneName);
    if (names.has(normalizedName)) {
      return Response.json(
        { error: "zone name repeated in this city", code: "duplicate_zone" },
        { status: 409 },
      );
    }

    if (zoneId !== null) ids.add(zoneId);
    names.add(normalizedName);
    zones.push({ id: zoneId, name: zoneName, is_active: isActive ?? true });
  }

  return zones;
}

async function readCityInput(req: Request): Promise<CityInput | Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("expected JSON body");
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("invalid JSON body");
  }

  const payload = body as Record<string, unknown>;
  const cityId = payload.city_id === undefined || payload.city_id === null
    ? null
    : payload.city_id;
  if (cityId !== null && !isUuid(cityId)) {
    return badRequest('invalid "city_id"');
  }

  const name = readLocationName(payload.name);
  if (name === null) return badRequest('missing/invalid "name"');

  if (!isUf(payload.uf)) return badRequest('missing/invalid "uf"');

  const zones = readZones(payload.zones);
  if (zones instanceof Response) return zones;

  return { cityId, name, uf: payload.uf, zones };
}

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const input = await readCityInput(req);
  if (input instanceof Response) return input;

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin.rpc("save_city", {
    p_city_id: input.cityId,
    p_name: input.name,
    p_uf: input.uf,
    p_zones: input.zones,
  });

  if (error) {
    switch (error.code) {
      case "CZ001":
        return Response.json({ error: "city not found" }, { status: 404 });
      case "CZ002":
        return Response.json(
          {
            error: "city already exists in this state",
            code: "duplicate_city",
          },
          { status: 409 },
        );
      case "CZ003":
        return badRequest("zone does not belong to city");
      case "CZ004":
        return Response.json(
          { error: "zone name repeated in this city", code: "duplicate_zone" },
          { status: 409 },
        );
      case "CZ005":
        return Response.json(
          {
            error: "zone has active groups",
            code: "zone_has_active_groups",
            zone: error.details,
          },
          { status: 409 },
        );
    }

    console.error("save-city-web save", oneLine(error.message));
    return Response.json({ error: "Unable to save city" }, { status: 500 });
  }

  return Response.json({ id: data }, { status: input.cityId ? 200 : 201 });
}));
