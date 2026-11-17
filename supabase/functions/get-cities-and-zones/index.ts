import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

type Zone = { id: string; name: string };
type City = { id: string; name: string; uf: string; zones: Zone[] };

// Dados de referência para o onboarding (e qualquer select futuro): todas as
// cidades e zonas, aninhadas e em ordem alfabética. A leitora autenticada já
// pode ler `cities`/`zones` pela REST, mas a function evita duas chamadas e
// monta o aninhamento no servidor, que é o formato das opções dependentes.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [citiesResult, zonesResult] = await Promise.all([
    ctx.supabaseAdmin.from("cities").select("id, name, uf").order("name"),
    ctx.supabaseAdmin.from("zones").select("id, name, city_id").order("name"),
  ]);

  const error = citiesResult.error ?? zonesResult.error;
  if (error) {
    console.error("get-cities-and-zones error", oneLine(error.message));
    return Response.json({ error: "Unable to load cities" }, { status: 500 });
  }

  const zonesByCity = new Map<string, Zone[]>();
  for (const zone of zonesResult.data ?? []) {
    const zones = zonesByCity.get(zone.city_id) ?? [];
    zones.push({ id: zone.id, name: zone.name });
    zonesByCity.set(zone.city_id, zones);
  }

  const cities: City[] = (citiesResult.data ?? []).map((city) => ({
    id: city.id,
    name: city.name,
    uf: city.uf,
    zones: zonesByCity.get(city.id) ?? [],
  }));

  return Response.json(cities);
}));
