import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";

const ACTIVE_REGISTRATION = "ACTIVE";

const GROUP_NUMBER = /^(?:grupo\s+)?0*(\d{1,9})$/i;
const GROUP_NAME = /^grupo\s+0*(\d{1,9})\s*[—–-]\s*(.+)$/i;

type GroupRow = {
  id: string;
  number: number;
  description: string;
  created_at: string;
  active: boolean;
  cities: { id: string; name: string } | null;
};

type GroupMetaRow = {
  active: boolean;
  city_id: string;
  cities: { id: string; name: string } | null;
};

type GroupUserRow = {
  group_id: string;
  is_coordinator: boolean;
  registration_status: string;
  users: { name: string; is_active: boolean } | null;
};

type MeetingRow = {
  group_id: string;
  date: string;
};

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

// Valor dentro de `.or()`: vírgula e parênteses do texto quebram o filtro sem aspas.
const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

const searchFilter = (search: string, cityIds: string[]) => {
  const filters = [`description.ilike.${quoted(likePattern(search))}`];

  if (cityIds.length > 0) filters.push(`city_id.in.(${cityIds.join(",")})`);

  const number = GROUP_NUMBER.exec(search);
  if (number) filters.push(`number.eq.${Number(number[1])}`);

  const name = GROUP_NAME.exec(search);
  if (name) {
    filters.push(
      `and(number.eq.${Number(name[1])},description.ilike.${
        quoted(likePattern(name[2].trim()))
      })`,
    );
  }

  return filters.join(",");
};

// Lista de grupos do painel web.
// Query string: page, pageSize, order, search, cityId.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const url = new URL(req.url);
  const { from, to, order } = parseListParams(url);
  const search = url.searchParams.get("search")?.trim() ?? "";
  const rawCityId = url.searchParams.get("cityId");
  const cityId = rawCityId && rawCityId !== "all" ? rawCityId : null;

  if (cityId && !isUuid(cityId)) {
    return Response.json({ error: "Invalid cityId" }, { status: 400 });
  }

  const metaResult = await ctx.supabaseAdmin
    .from("groups")
    .select("active, city_id, cities(id, name)");

  if (metaResult.error) {
    console.error(
      "get-groups-web metadata error",
      oneLine(metaResult.error.message),
    );
    return Response.json({ error: metaResult.error.message }, { status: 500 });
  }

  const metaRows = (metaResult.data ?? []) as unknown as GroupMetaRow[];

  let activeGroups = 0;
  const activeCityIds = new Set<string>();
  const cityMap = new Map<string, string>();

  for (const group of metaRows) {
    if (group.cities) cityMap.set(group.cities.id, group.cities.name);
    if (group.active) {
      activeGroups += 1;
      activeCityIds.add(group.city_id);
    }
  }

  const cities = [...cityMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const summary = { activeGroups, cities: activeCityIds.size };

  let groupsQuery = ctx.supabaseAdmin
    .from("groups")
    .select("id, number, description, created_at, active, cities(id, name)", {
      count: "exact",
    });

  if (cityId) groupsQuery = groupsQuery.eq("city_id", cityId);

  if (search) {
    const normalizedSearch = normalizeText(search);
    const matchingCityIds = cities
      .filter((city) => normalizeText(city.name).includes(normalizedSearch))
      .map((city) => city.id);

    groupsQuery = groupsQuery.or(searchFilter(search, matchingCityIds));
  }

  groupsQuery = order.column === "name"
    ? groupsQuery
      .order("number", { ascending: order.ascending })
      .order("description", { ascending: order.ascending })
    : groupsQuery.order(order.column, { ascending: order.ascending });

  const { data, error, count } = await groupsQuery
    .order("id")
    .range(from, to);

  if (error) {
    console.error("get-groups-web groups error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  const groupRows = (data ?? []) as unknown as GroupRow[];
  const total = count ?? 0;

  if (groupRows.length === 0) {
    return Response.json({ items: [], total, summary, cities });
  }

  const groupIds = groupRows.map((group) => group.id);

  const [membersResult, meetingsResult] = await Promise.all([
    ctx.supabaseAdmin
      .from("group_users")
      .select(
        "group_id, is_coordinator, registration_status, users(name, is_active)",
      )
      .in("group_id", groupIds)
      .order("id"),

    ctx.supabaseAdmin
      .from("meetings")
      .select("group_id, date")
      .in("group_id", groupIds)
      .not("date", "is", null)
      .gte("date", new Date().toISOString())
      .neq("status", "CONCLUDED")
      .order("date", { ascending: true }),
  ]);

  const detailError = membersResult.error ?? meetingsResult.error;

  if (detailError) {
    console.error("get-groups-web details error", oneLine(detailError.message));
    return Response.json({ error: detailError.message }, { status: 500 });
  }

  const memberCountByGroup = new Map<string, number>();
  const coordinatorByGroup = new Map<string, string>();
  const nextMeetingByGroup = new Map<string, string>();

  for (
    const membership of (membersResult.data ?? []) as unknown as GroupUserRow[]
  ) {
    if (
      membership.registration_status === ACTIVE_REGISTRATION &&
      membership.users?.is_active
    ) {
      memberCountByGroup.set(
        membership.group_id,
        (memberCountByGroup.get(membership.group_id) ?? 0) + 1,
      );
    }

    if (
      membership.is_coordinator &&
      membership.users?.name &&
      !coordinatorByGroup.has(membership.group_id)
    ) {
      coordinatorByGroup.set(membership.group_id, membership.users.name);
    }
  }

  for (
    const meeting of (meetingsResult.data ?? []) as unknown as MeetingRow[]
  ) {
    if (!nextMeetingByGroup.has(meeting.group_id)) {
      nextMeetingByGroup.set(meeting.group_id, meeting.date);
    }
  }

  const items = groupRows.map((group) => ({
    id: group.id,
    number: group.number,
    description: group.description,
    createdAt: group.created_at,
    city: group.cities
      ? { id: group.cities.id, name: group.cities.name }
      : null,
    coordinator: coordinatorByGroup.get(group.id) ?? null,
    members: memberCountByGroup.get(group.id) ?? 0,
    nextMeetingAt: nextMeetingByGroup.get(group.id) ?? null,
    status: group.active ? "active" : "closed",
  }));

  return Response.json({ items, total, summary, cities });
}));
