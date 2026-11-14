import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";
import { RECORD_STATUSES } from "../_shared/meetingRecord.ts";
import { getMonthBoundaries } from "../_shared/date.ts";

Deno.serve(
  withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
    if (denied) return denied;

    const { count: total, error: totalError } = await ctx.supabaseAdmin
      .from("groups")
      .select("id", { count: "exact", head: true });

    if (totalError) {
      console.error(
        "get-dashboard-kpis-web total",
        oneLine(totalError.message),
      );
      return Response.json({ error: "unable to load groups" }, { status: 500 });
    }

    const { count: active, error: activeError } = await ctx.supabaseAdmin
      .from("groups")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);

    if (activeError) {
      console.error(
        "get-dashboard-kpis-web active",
        oneLine(activeError.message),
      );
      return Response.json({ error: "unable to load groups" }, { status: 500 });
    }

    const { previousMonthStart, currentMonthStart, nextMonthStart } =
      getMonthBoundaries();

    const [currentMonthResult, previousMonthResult] = await Promise.all([
      ctx.supabaseAdmin
        .from("meetings")
        .select("id", { count: "exact", head: true })
        .in("status", RECORD_STATUSES)
        .gte("date", currentMonthStart)
        .lt("date", nextMonthStart),

      ctx.supabaseAdmin
        .from("meetings")
        .select("id", { count: "exact", head: true })
        .in("status", RECORD_STATUSES)
        .gte("date", previousMonthStart)
        .lt("date", currentMonthStart),
    ]);

    if (currentMonthResult.error) {
      console.error(
        "get-dashboard-kpis-web meetings currentMonth",
        oneLine(currentMonthResult.error.message),
      );
      return Response.json(
        { error: "unable to load meetings" },
        { status: 500 },
      );
    }

    if (previousMonthResult.error) {
      console.error(
        "get-dashboard-kpis-web meetings previousMonth",
        oneLine(previousMonthResult.error.message),
      );
      return Response.json(
        { error: "unable to load meetings" },
        { status: 500 },
      );
    }

    return Response.json({
      groups: {
        active: active ?? 0,
        total: total ?? 0,
      },
      meetings: {
        currentMonth: currentMonthResult.count ?? 0,
        previousMonth: previousMonthResult.count ?? 0,
      },
    });
  }),
);
