import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";

// Dados de apoio da tela de participantes: opções dos filtros de cidade e grupo
// e o resumo "X grupos ativos em Y cidades" do cabeçalho.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (_req, ctx) => {
  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const [citiesResult, groupsResult] = await Promise.all([
    ctx.supabaseAdmin.from("cities").select("id, name").order("name"),
    ctx.supabaseAdmin
      .from("groups")
      .select("id, number, description, city_id")
      .eq("active", true)
      .order("number"),
  ]);

  const error = citiesResult.error ?? groupsResult.error;
  if (error) {
    console.error("get-participant-filters error", error);
    return Response.json({ error: error.message }, { status: 400 });
  }

  const groups = groupsResult.data ?? [];

  return Response.json({
    cities: citiesResult.data ?? [],
    groups: groups.map(({ id, number, description }) => ({ id, number, description })),
    summary: {
      groups: groups.length,
      cities: new Set(groups.map((group) => group.city_id)).size,
    },
  });
}));
