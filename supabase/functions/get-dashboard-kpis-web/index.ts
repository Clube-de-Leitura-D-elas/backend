import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";
import { RECORD_STATUSES } from "../_shared/meetingRecord.ts";

const TIME_ZONE = "America/Sao_Paulo";

function getMonthStart(year: number, month: number): string {
  // month pode ser 0 ou 13; Date ajusta automaticamente o ano.
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const targetYear = normalized.getUTCFullYear();
  const targetMonth = normalized.getUTCMonth() + 1;

  // Descobre o offset de São Paulo na data aproximada.
  const approximate = new Date(Date.UTC(targetYear, targetMonth - 1, 1));

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(approximate);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  const offset = localAsUtc - approximate.getTime();

  return new Date(approximate.getTime() - offset).toISOString();
}

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

    const dateParts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "numeric",
    }).formatToParts(new Date());

    const year = Number(dateParts.find((part) => part.type === "year")?.value);
    const month = Number(
      dateParts.find((part) => part.type === "month")?.value,
    );

    const previousMonthStart = getMonthStart(year, month - 1);
    const currentMonthStart = getMonthStart(year, month);
    const nextMonthStart = getMonthStart(year, month + 1);

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
