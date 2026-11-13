import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readDateRangeParams } from "../_shared/dateRange.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";

// Protege o generate_series da RPC: 60 meses (~1825 dias) cabem no limite.
const MAX_RANGE_DAYS = 1830;

type ActiveParticipantsRow = { period: string; total: number | string };

// Gráfico "Total de Participantes" do dashboard do painel web: participantes
// ativas ao fim de cada mês. O web pede 60 meses e recorta no navegador.
// Query string: from e to (YYYY-MM-DD, inclusivos).
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const range = readDateRangeParams(new URL(req.url), {
    maxDays: MAX_RANGE_DAYS,
  });
  if (range instanceof Response) return range;

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin.rpc(
    "dashboard_active_participants",
    { p_from: range.from, p_to: range.to },
  );

  if (error) {
    console.error(
      "get-dashboard-active-participants-web rpc",
      oneLine(error.message),
    );
    return Response.json({ error: "unable to load active participants" }, {
      status: 500,
    });
  }

  return Response.json({
    items: ((data ?? []) as ActiveParticipantsRow[]).map((row) => ({
      period: row.period,
      total: Number(row.total),
    })),
  });
}));
