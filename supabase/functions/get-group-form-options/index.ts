import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const [citiesResult, zonesResult, coordinatorsResult] = await Promise.all([
    ctx.supabaseAdmin.from("cities").select("id, name").order("name"),
    ctx.supabaseAdmin.from("zones").select("id, name, city_id").order("name"),
    ctx.supabaseAdmin
      .from("users")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
  ]);

  const error = citiesResult.error ?? zonesResult.error ?? coordinatorsResult.error;
  if (error) {
    console.error("get-group-form-options error", oneLine(error.message));
    return Response.json({ error: "unable to load group form options" }, { status: 500 });
  }

  return Response.json({
    cities: citiesResult.data ?? [],
    zones: (zonesResult.data ?? []).map((zone) => ({
      id: zone.id,
      name: zone.name,
      cityId: zone.city_id,
    })),
    coordinators: coordinatorsResult.data ?? [],
  });
}));
