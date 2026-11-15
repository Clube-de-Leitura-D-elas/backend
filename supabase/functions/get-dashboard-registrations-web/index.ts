import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readDateRangeParams } from "../_shared/dateRange.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";

const GRANULARITIES = new Set(["month", "week"]);

// Protege o generate_series da RPC: ~5 anos dão 60 meses ou ~260 semanas.
const MAX_RANGE_DAYS = 1830;

type RegistrationRow = { period: string; total: number | string };

// Gráfico "Novas inscrições" do dashboard do painel web.
// Query string: granularity (month | week), from e to (YYYY-MM-DD, inclusivos).
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(req.url);
  const granularity = url.searchParams.get("granularity");
  if (!granularity || !GRANULARITIES.has(granularity)) {
    return Response.json(
      { error: 'missing/invalid "granularity" (expected month or week)' },
      { status: 400 },
    );
  }

  const range = readDateRangeParams(url, { maxDays: MAX_RANGE_DAYS });
  if (range instanceof Response) return range;

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin.rpc(
    "dashboard_registrations",
    { p_from: range.from, p_to: range.to, p_granularity: granularity },
  );

  if (error) {
    console.error(
      "get-dashboard-registrations-web rpc",
      oneLine(error.message),
    );
    return Response.json({ error: "unable to load registrations" }, {
      status: 500,
    });
  }

  return Response.json({
    items: ((data ?? []) as RegistrationRow[]).map((row) => ({
      period: row.period,
      total: Number(row.total),
    })),
  });
}));
