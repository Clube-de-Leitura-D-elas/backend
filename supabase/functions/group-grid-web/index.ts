import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

import type { Database } from "../_shared/database.ts";
import { requireManagement } from "../_shared/management.ts";
import { isUuid } from "../_shared/uuid.ts";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 6;
const MAX_PAGE_SIZE = 100;

type GroupOrder = "name_asc" | "name_desc";

type GroupGridRequest = {
  page?: number;
  pageSize?: number;
  search?: string;
  cityId?: string | null;
  order?: GroupOrder;
};

type GroupRow = {
  id: string;
  number: number;
  description: string;
  created_at: string;
  active: boolean;
  city_id: string;
  cities: {
    id: string;
    name: string;
  } | null;
};

type SearchGroupRow = {
  id: string;
  number: number;
  description: string;
  cities: {
    name: string;
  } | null;
};

type GroupUserRow = {
  group_id: string;
  is_coordinator: boolean;
  users: {
    name: string;
  } | null;
};

type MeetingRow = {
  group_id: string;
  date: string | null;
};

type GroupMetaRow = {
  active: boolean;
  city_id: string;
  cities: {
    id: string;
    name: string;
  } | null;
};

const toPositiveInt = (value: unknown, fallback: number) => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
};

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

const formatGroupName = (number: number, description: string) =>
  `Grupo ${String(number).padStart(2, "0")} — ${description}`;

const parseRequest = async (
  req: Request,
): Promise<Required<GroupGridRequest>> => {
  let body: GroupGridRequest = {};

  if (req.method === "POST") {
    body = await req.json().catch(() => ({} as GroupGridRequest));
  }

  const url = new URL(req.url);

  const page = toPositiveInt(
    body.page ?? url.searchParams.get("page"),
    DEFAULT_PAGE,
  );

  const pageSize = Math.min(
    toPositiveInt(
      body.pageSize ?? url.searchParams.get("pageSize"),
      DEFAULT_PAGE_SIZE,
    ),
    MAX_PAGE_SIZE,
  );

  const search = String(
    body.search ?? url.searchParams.get("search") ?? "",
  ).trim();

  const rawCityId =
    body.cityId ?? url.searchParams.get("cityId") ?? null;

  const cityId =
    rawCityId && rawCityId !== "all"
      ? rawCityId
      : null;

  const rawOrder =
    body.order ?? url.searchParams.get("order");

  const order: GroupOrder =
    rawOrder === "name_desc"
      ? "name_desc"
      : "name_asc";

  return {
    page,
    pageSize,
    search,
    cityId,
    order,
  };
};

Deno.serve(
  withSupabase<Database>(
    { auth: "user" },
    async (req, ctx) => {
      if (req.method !== "GET" && req.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405 },
        );
      }

      const denied = await requireManagement(ctx);

      if (denied) {
        return denied;
      }

      const {
        page,
        pageSize,
        search,
        cityId,
        order,
      } = await parseRequest(req);

      if (cityId && !isUuid(cityId)) {
        return Response.json(
          { error: "Invalid cityId" },
          { status: 400 },
        );
      }

      /*
       * Cabeçalho e opções de cidade.
       *
       * Esses dados não são afetados pela busca, filtro ou paginação
       * aplicada na tabela.
       */
      const metaPromise = ctx.supabase
        .from("groups")
        .select(
          `
            active,
            city_id,
            cities (
              id,
              name
            )
          `,
        );

      /*
       * A busca precisa considerar:
       *
       * - nome completo do grupo;
       * - descrição;
       * - número;
       * - cidade.
       *
       * Como o nome exibido é montado usando number + description
       * e a cidade está em uma relação, primeiro encontramos os IDs
       * que combinam com a busca.
       */
      let matchingGroupIds: string[] | null = null;

      if (search) {
        let searchQuery = ctx.supabase
          .from("groups")
          .select(
            `
              id,
              number,
              description,
              cities (
                name
              )
            `,
          );

        if (cityId) {
          searchQuery = searchQuery.eq("city_id", cityId);
        }

        const {
          data: searchData,
          error: searchError,
        } = await searchQuery;

        if (searchError) {
          console.error(
            "group-grid-web search error",
            searchError,
          );

          return Response.json(
            { error: searchError.message },
            { status: 400 },
          );
        }

        const normalizedSearch = normalizeText(search);

        matchingGroupIds = (
          (searchData ?? []) as unknown as SearchGroupRow[]
        )
          .filter((group) => {
            const groupName = formatGroupName(
              group.number,
              group.description,
            );

            const searchableText = normalizeText(
              `${groupName} ${group.description} ${
                group.cities?.name ?? ""
              }`,
            );

            return searchableText.includes(
              normalizedSearch,
            );
          })
          .map((group) => group.id);
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;

      let groupRows: GroupRow[] = [];
      let total = 0;

      /*
       * Se existe uma busca e nenhum grupo combinou,
       * não executamos .in("id", []).
       */
      if (!search || (matchingGroupIds?.length ?? 0) > 0) {
        let groupsQuery = ctx.supabase
          .from("groups")
          .select(
            `
              id,
              number,
              description,
              created_at,
              active,
              city_id,
              cities (
                id,
                name
              )
            `,
            {
              count: "exact",
            },
          );

        if (cityId) {
          groupsQuery = groupsQuery.eq(
            "city_id",
            cityId,
          );
        }

        if (matchingGroupIds) {
          groupsQuery = groupsQuery.in(
            "id",
            matchingGroupIds,
          );
        }

        const ascending = order === "name_asc";

        const {
          data,
          error,
          count,
        } = await groupsQuery
          .order("number", { ascending })
          .order("description", { ascending })
          .order("id", { ascending: true })
          .range(from, to);

        if (error) {
          console.error(
            "group-grid-web groups error",
            error,
          );

          return Response.json(
            { error: error.message },
            { status: 400 },
          );
        }

        groupRows =
          (data ?? []) as unknown as GroupRow[];

        total = count ?? 0;
      }

      const metaResult = await metaPromise;

      if (metaResult.error) {
        console.error(
          "group-grid-web metadata error",
          metaResult.error,
        );

        return Response.json(
          { error: metaResult.error.message },
          { status: 400 },
        );
      }

      const metaRows =
        (metaResult.data ?? []) as unknown as GroupMetaRow[];

      /*
       * Cabeçalho:
       *
       * "42 grupos ativos em 7 cidades"
       */
      let activeGroups = 0;

      const activeCityIds = new Set<string>();
      const cityMap = new Map<string, string>();

      for (const group of metaRows) {
        if (group.cities) {
          cityMap.set(
            group.cities.id,
            group.cities.name,
          );
        }

        if (group.active) {
          activeGroups += 1;
          activeCityIds.add(group.city_id);
        }
      }

      /*
       * Também devolvemos as cidades disponíveis.
       *
       * Isso alimenta o Dropdown:
       * "Cidade: todas".
       */
      const cities = [...cityMap.entries()]
        .map(([id, name]) => ({
          id,
          name,
        }))
        .sort((a, b) =>
          a.name.localeCompare(b.name, "pt-BR")
        );

      /*
       * Página vazia.
       *
       * Ainda precisamos devolver total, cabeçalho
       * e opções de cidades.
       */
      if (groupRows.length === 0) {
        return Response.json({
          items: [],
          total,
          summary: {
            activeGroups,
            cities: activeCityIds.size,
          },
          cities,
        });
      }

      const groupIds = groupRows.map(
        (group) => group.id,
      );

      /*
       * Informações complementares:
       *
       * - quantidade de membras;
       * - coordenadora;
       * - próximo encontro.
       */
      const [
        membersResult,
        meetingsResult,
      ] = await Promise.all([
        ctx.supabase
          .from("group_users")
          .select(
            `
              group_id,
              is_coordinator,
              users (
                name
              )
            `,
          )
          .in("group_id", groupIds)
          .order("id"),

        ctx.supabase
          .from("meetings")
          .select(
            `
              group_id,
              date
            `,
          )
          .in("group_id", groupIds)
          .not("date", "is", null)
          .gte(
            "date",
            new Date().toISOString(),
          )
          .neq("status", "CONCLUDED")
          .order("date", { ascending: true }),
      ]);

      const detailError =
        membersResult.error ??
        meetingsResult.error;

      if (detailError) {
        console.error(
          "group-grid-web details error",
          detailError,
        );

        return Response.json(
          { error: detailError.message },
          { status: 400 },
        );
      }

      const memberships =
        (membersResult.data ??
          []) as unknown as GroupUserRow[];

      const meetings =
        (meetingsResult.data ??
          []) as unknown as MeetingRow[];

      const memberCountByGroup =
        new Map<string, number>();

      const coordinatorByGroup =
        new Map<string, string>();

      const nextMeetingByGroup =
        new Map<string, string>();

      /*
       * Conta as membras e encontra a coordenadora.
       */
      for (const membership of memberships) {
        memberCountByGroup.set(
          membership.group_id,
          (
            memberCountByGroup.get(
              membership.group_id,
            ) ?? 0
          ) + 1,
        );

        if (
          membership.is_coordinator &&
          membership.users?.name &&
          !coordinatorByGroup.has(
            membership.group_id,
          )
        ) {
          coordinatorByGroup.set(
            membership.group_id,
            membership.users.name,
          );
        }
      }

      /*
       * Como meetings já está ordenado por data,
       * o primeiro encontrado para cada grupo
       * é o próximo encontro.
       */
      for (const meeting of meetings) {
        if (
          meeting.date &&
          !nextMeetingByGroup.has(
            meeting.group_id,
          )
        ) {
          nextMeetingByGroup.set(
            meeting.group_id,
            meeting.date,
          );
        }
      }

      /*
       * Contrato final consumido pela tela.
       */
      const items = groupRows.map((group) => ({
        id: group.id,

        name: formatGroupName(
          group.number,
          group.description,
        ),

        createdAt: group.created_at,

        city: group.cities
          ? {
              id: group.cities.id,
              name: group.cities.name,
            }
          : null,

        coordinator:
          coordinatorByGroup.get(group.id) ??
          null,

        members:
          memberCountByGroup.get(group.id) ??
          0,

        nextMeetingAt:
          nextMeetingByGroup.get(group.id) ??
          null,

        status: group.active
          ? "active"
          : "closed",
      }));

      return Response.json({
        items,
        total,

        summary: {
          activeGroups,
          cities: activeCityIds.size,
        },

        cities,
      });
    },
  ),
);