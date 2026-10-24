
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";

type GroupRow = {
  id: string;
  number: number;
  description: string;
  cities: {
    name: string;
    uf: string;
  } | null;
};

type MeetingRow = {
  id: string;
  group_id: string;
  date: string;
  status: string;
};

type CalendarEvent = {
  id: string;
  groupId: string;
  groupName: string;
  city: string;
  startsAt: string;
  status: string;
};

type CalendarDay = {
  date: string;
  inMonth: boolean;
  events: CalendarEvent[];
};

const TIME_ZONE = "America/Sao_Paulo";
const PAGE_SIZE = 500;

const localDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

function formatUTCDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatLocalDate(value: string): string {
  const parts = localDateFormatter.formatToParts(new Date(value));

  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
}

function getCalendarDays(year: number, month: number): CalendarDay[] {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const offset = firstDay.getUTCDay();
  const totalDays = Math.ceil((offset + daysInMonth) / 7) * 7;

  const start = new Date(firstDay);
  start.setUTCDate(start.getUTCDate() - offset);

  return Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);

    return {
      date: formatUTCDate(date),
      inMonth: date.getUTCMonth() === month - 1,
      events: [],
    };
  });
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function dbError(step: string, message: string): Response {
  console.error(`calendar-month ${step} error`, oneLine(message));

  return Response.json(
    { error: "Erro ao consultar os dados do calendário." },
    { status: 500 },
  );
}

// Calendário mensal do painel web.
// Query string: year, month, state?, city?, groupId?.
// Sempre retorna o mês completo, sem atualização incremental.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405 },
    );
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const url = new URL(req.url);

  const yearParam = url.searchParams.get("year");
  const monthParam = url.searchParams.get("month");

  if (!yearParam || !/^\d{4}$/.test(yearParam)) {
    return badRequest("Invalid year");
  }

  if (!monthParam || !/^\d{1,2}$/.test(monthParam)) {
    return badRequest("Invalid month");
  }

  const year = Number(yearParam);
  const month = Number(monthParam);

  if (year < 1000 || year > 9998) {
    return badRequest("Invalid year");
  }

  if (month < 1 || month > 12) {
    return badRequest("Invalid month");
  }

  const state = url.searchParams.get("state")?.trim().toUpperCase() ?? "";
  const city = url.searchParams.get("city")?.trim() ?? "";
  const groupId = url.searchParams.get("groupId")?.trim() ?? "";

  if (state && !/^[A-Z]{2}$/.test(state)) {
    return badRequest("Invalid state");
  }

  if (groupId && !isUuid(groupId)) {
    return badRequest("Invalid groupId");
  }

  const days = getCalendarDays(year, month);
  const rangeStart = days[0].date;
  const rangeEnd = days[days.length - 1].date;

  const responseBase = {
    year,
    month,
    rangeStart,
    rangeEnd,
  };

  // Busca grupos ativos, incluindo os dados da cidade.
  let groupsQuery = ctx.supabaseAdmin
    .from("groups")
    .select("id, number, description, cities(name, uf)")
    .eq("active", true);

  if (groupId) {
    groupsQuery = groupsQuery.eq("id", groupId);
  }

  const { data: groupsData, error: groupsError } = await groupsQuery;

  if (groupsError) {
    return dbError("groups", groupsError.message);
  }

  const groups = ((groupsData ?? []) as unknown as GroupRow[])
    .filter((group) => {
      if (state && group.cities?.uf?.toUpperCase() !== state) {
        return false;
      }

      if (
        city &&
        normalizeText(group.cities?.name ?? "") !== normalizeText(city)
      ) {
        return false;
      }

      return true;
    });

  if (groups.length === 0) {
    return Response.json({ ...responseBase, days });
  }

  const groupById = new Map(
    groups.map((group) => [group.id, group]),
  );

  const groupIds = groups.map((group) => group.id);

  // Consulta com margem UTC para incluir encontros próximos
  // da meia-noite que pertencem ao dia local visível.
  const from = new Date(`${rangeStart}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);

  const until = new Date(`${rangeEnd}T00:00:00.000Z`);
  until.setUTCDate(until.getUTCDate() + 2);

  const meetings: MeetingRow[] = [];

  // Paginação para não depender do limite padrão de linhas.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await ctx.supabaseAdmin
      .from("meetings")
      .select("id, group_id, date, status")
      .in("group_id", groupIds)
      .not("date", "is", null)
      .gte("date", from.toISOString())
      .lt("date", until.toISOString())
      .order("date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      return dbError("meetings", error.message);
    }

    const batch = (data ?? []) as MeetingRow[];
    meetings.push(...batch);

    if (batch.length < PAGE_SIZE) break;
  }

  const dayByDate = new Map(
    days.map((day) => [day.date, day]),
  );

  for (const meeting of meetings) {
    const group = groupById.get(meeting.group_id);

    if (!group) continue;

    const date = formatLocalDate(meeting.date);
    const day = dayByDate.get(date);

    if (!day) continue;

    day.events.push({
      id: meeting.id,
      groupId: group.id,
      groupName:
        `Grupo ${String(group.number).padStart(2, "0")} — ${group.description}`,
      city: group.cities?.name ?? "",
      startsAt: meeting.date,
      status: meeting.status,
    });
  }

  for (const day of days) {
    day.events.sort(
      (a, b) =>
        new Date(a.startsAt).getTime() -
          new Date(b.startsAt).getTime() ||
        a.id.localeCompare(b.id),
    );
  }

  return Response.json({
    ...responseBase,
    days,
  });
}));
