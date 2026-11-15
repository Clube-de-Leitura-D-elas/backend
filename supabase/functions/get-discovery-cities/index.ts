import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { loadDiscoveryReader } from "../_shared/groupDiscovery.ts";
import { oneLine } from "../_shared/log.ts";

type City = { id: string; name: string; uf: string };

// Opções do filtro de cidade do calendário e da busca de grupos do app:
// cidades com grupo ativo, mais a da leitora (o filtro abre nela, mesmo sem
// grupo), em ordem alfabética. `reader_city_id` é a seleção inicial.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const reader = await loadDiscoveryReader(ctx, "get-discovery-cities");
  if (reader instanceof Response) return reader;

  const [groups, readerCity] = await Promise.all([
    ctx.supabaseAdmin
      .from("groups")
      .select("cities(id, name, uf)")
      .eq("is_active", true),
    ctx.supabaseAdmin
      .from("cities")
      .select("id, name, uf")
      .eq("id", reader.cityId)
      .maybeSingle(),
  ]);

  const error = groups.error ?? readerCity.error;
  if (error) {
    console.error("get-discovery-cities cities", oneLine(error.message));
    return Response.json({ error: "Unable to load cities" }, { status: 500 });
  }

  const cities = new Map<string, City>();
  const rows = (groups.data ?? []) as unknown as { cities: City | null }[];
  for (const city of [...rows.map((row) => row.cities), readerCity.data]) {
    if (city) {
      cities.set(city.id, { id: city.id, name: city.name, uf: city.uf });
    }
  }

  return Response.json({
    reader_city_id: reader.cityId,
    cities: [...cities.values()].sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR") || a.uf.localeCompare(b.uf)
    ),
  });
}));
