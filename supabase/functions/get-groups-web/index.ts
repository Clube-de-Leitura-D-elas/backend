import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";

const ACTIVE_REGISTRATION = "ACTIVE";

const GROUP_LABEL = "grupo";
const GROUP_NUMBER = /^(?:grupo\s*)?(\d{1,9})(?:\s*[—–-])?$/i;
const GROUP_NAME = /^(?:grupo\s*)?(\d{1,9})\s*[—–-]\s*(.+)$/i;

const RANGE_NOT_SATISFIABLE = "PGRST103";

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

type CoordinatorRow = {
  group_id: string;
  users: { name: string };
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

// O PostgREST troca `*` por `%` mesmo entre aspas; `_` mantém um caractere só.
const likePattern = (value: string) =>
  `%${value.replace(/[\\%_]/g, "\\$&").replaceAll("*", "_")}%`;

// Valor dentro de `.or()`: vírgula e parênteses do texto quebram o filtro sem aspas.
const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

// "Grupo 0" é o começo de "Grupo 01" a "Grupo 09".
const numberFilter = (digits: string) =>
  /^0+$/.test(digits) ? "number.lt.10" : `number.eq.${Number(digits)}`;

const searchFilter = (search: string, cityIds: string[]) => {
  const filters = [`description.ilike.${quoted(likePattern(search))}`];

  if (cityIds.length > 0) filters.push(`city_id.in.(${cityIds.join(",")})`);

  const number = GROUP_NUMBER.exec(search);
  if (number) filters.push(numberFilter(number[1]));

  const name = GROUP_NAME.exec(search);
  if (name) {
    filters.push(
      `and(${numberFilter(name[1])},description.ilike.${
        quoted(likePattern(name[2].trim()))
      })`,
    );
  }

  return filters.join(",");
};

const dbError = (step: string, message: string) => {
  console.error(`get-groups-web ${step} error`, oneLine(message));
  return Response.json({ error: message }, { status: 500 });
};

// Cabeçalho e opções de cidade: não dependem de busca, filtro ou página.
const loadMeta = async (ctx: SupabaseContext<Database>) => {
  const { data, error } = await ctx.supabaseAdmin
    .from("groups")
    .select("active, city_id, cities(id, name)");

  if (error) return dbError("metadata", error.message);

  let activeGroups = 0;
  const activeCityIds = new Set<string>();
  const cityMap = new Map<string, string>();

  for (const group of (data ?? []) as unknown as GroupMetaRow[]) {
    if (group.cities) cityMap.set(group.cities.id, group.cities.name);
    if (group.active) {
      activeGroups += 1;
      activeCityIds.add(group.city_id);
    }
  }

  const cities = [...cityMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return { summary: { activeGroups, cities: activeCityIds.size }, cities };
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
  const rawSearch = url.searchParams.get("search")?.trim() ?? "";
  const search = GROUP_LABEL.includes(normalizeText(rawSearch))
    ? ""
    : rawSearch;
  const rawCityId = url.searchParams.get("cityId");
  const cityId = rawCityId && rawCityId !== "all" ? rawCityId : null;

  if (cityId && !isUuid(cityId)) {
    return Response.json({ error: "Invalid cityId" }, { status: 400 });
  }

  const metaPromise = loadMeta(ctx);

  let searchOr: string | null = null;
  if (search) {
    const meta = await metaPromise;
    if (meta instanceof Response) return meta;

    const normalizedSearch = normalizeText(search);
    const matchingCityIds = meta.cities
      .filter((city) => normalizeText(city.name).includes(normalizedSearch))
      .map((city) => city.id);

    searchOr = searchFilter(search, matchingCityIds);
  }

  const filteredGroups = (
    columns: string,
    options: { count: "exact"; head?: boolean },
  ) => {
    let query = ctx.supabaseAdmin.from("groups").select(columns, options);
    if (cityId) query = query.eq("city_id", cityId);
    if (searchOr) query = query.or(searchOr);
    return query;
  };

  let groupsQuery = filteredGroups(
    "id, number, description, created_at, active, cities(id, name)",
    { count: "exact" },
  );

  groupsQuery = order.column === "name"
    ? groupsQuery
      .order("number", { ascending: order.ascending })
      .order("description", { ascending: order.ascending })
    : groupsQuery.order(order.column, { ascending: order.ascending });

  const [meta, groupsResult] = await Promise.all([
    metaPromise,
    groupsQuery.order("id").range(from, to),
  ]);

  if (meta instanceof Response) return meta;
  const { summary, cities } = meta;

  if (groupsResult.error?.code === RANGE_NOT_SATISFIABLE) {
    const { count, error } = await filteredGroups("id", {
      count: "exact",
      head: true,
    });
    if (error) return dbError("groups count", error.message);
    return Response.json({ items: [], total: count ?? 0, summary, cities });
  }

  if (groupsResult.error) return dbError("groups", groupsResult.error.message);

  const groupRows = (groupsResult.data ?? []) as unknown as GroupRow[];
  const total = groupsResult.count ?? 0;

  if (groupRows.length === 0) {
    return Response.json({ items: [], total, summary, cities });
  }

  const groupIds = groupRows.map((group) => group.id);

  const [membersResult, coordinatorsResult, meetingsResult] = await Promise.all(
    [
      ctx.supabaseAdmin
        .from("group_users")
        .select("group_id, users!inner(is_active)")
        .in("group_id", groupIds)
        .eq("registration_status", ACTIVE_REGISTRATION)
        .eq("users.is_active", true),

      ctx.supabaseAdmin
        .from("group_users")
        .select("group_id, users!inner(name)")
        .in("group_id", groupIds)
        .eq("is_coordinator", true)
        .order("id"),

      ctx.supabaseAdmin
        .from("meetings")
        .select("group_id, date")
        .in("group_id", groupIds)
        .not("date", "is", null)
        .gte("date", new Date().toISOString())
        .neq("status", "CONCLUDED")
        .order("date", { ascending: true }),
    ],
  );

  const detailError = membersResult.error ?? coordinatorsResult.error ??
    meetingsResult.error;
  if (detailError) return dbError("details", detailError.message);

  const memberCountByGroup = new Map<string, number>();
  const coordinatorByGroup = new Map<string, string>();
  const nextMeetingByGroup = new Map<string, string>();

  for (const member of (membersResult.data ?? []) as { group_id: string }[]) {
    memberCountByGroup.set(
      member.group_id,
      (memberCountByGroup.get(member.group_id) ?? 0) + 1,
    );
  }

  for (
    const coordinator of (coordinatorsResult.data ??
      []) as unknown as CoordinatorRow[]
  ) {
    if (!coordinatorByGroup.has(coordinator.group_id)) {
      coordinatorByGroup.set(coordinator.group_id, coordinator.users.name);
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
