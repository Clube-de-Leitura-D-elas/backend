import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  loadDiscoveryReader,
  loadGroupDiscoveryInfo,
} from "../_shared/groupDiscovery.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";
import { isUuid } from "../_shared/uuid.ts";

type GroupRow = {
  id: string;
  number: number;
  description: string;
  cities: { name: string; uf: string } | null;
  photos: { url: string } | null;
  group_genres: { genres: { id: string; name: string } | null }[];
};

type Filters = {
  search: string;
  genreId: string | null;
  groupId: string | null;
  minParticipants: number | null;
  maxParticipants: number | null;
};

const normalize = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR").trim();

// "Buscar novo grupo" do app: grupos ativos da cidade da leitora, com busca,
// filtro de gênero e de nº de participantes, e a situação dela em cada um.
// Filtra e pagina em memória: a contagem de participantes não é coluna, e uma
// cidade tem poucos grupos. `genres` traz as opções do filtro (gêneros dos
// grupos da cidade). Ordem fixa por número do grupo (`order` é ignorado).
// `groupId` devolve só aquele grupo, se for ativo e da cidade da leitora (senão
// `items` vazio): é o detalhe do grupo para quem não é membro, já que
// get-group-details exige ser membro. Com ele, `genres` são só os do grupo.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const url = new URL(req.url);
  const filters = readFilters(url);
  if (filters instanceof Response) return filters;
  const { from, to } = parseListParams(url);

  const reader = await loadDiscoveryReader(ctx, "get-city-groups");
  if (reader instanceof Response) return reader;

  let query = ctx.supabaseAdmin
    .from("groups")
    .select(
      "id, number, description, cities(name, uf), photos(url), group_genres(genres(id, name))",
    )
    .eq("city_id", reader.cityId)
    .eq("is_active", true)
    .order("number", { ascending: true });
  if (filters.groupId) query = query.eq("id", filters.groupId);

  const { data, error } = await query;

  if (error) {
    console.error("get-city-groups groups", oneLine(error.message));
    return Response.json({ error: "Unable to load groups" }, { status: 500 });
  }

  const groups = (data ?? []) as unknown as GroupRow[];
  const info = await loadGroupDiscoveryInfo(
    ctx,
    reader.profileId,
    groups.map((group) => group.id),
    "get-city-groups",
  );
  if (info instanceof Response) return info;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    groups.map((group) => group.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  const genreOptions = new Map<string, string>();
  const items = groups.map((group) => {
    const genres = group.group_genres
      .map((row) => row.genres)
      .filter((genre): genre is { id: string; name: string } => !!genre);
    for (const genre of genres) genreOptions.set(genre.id, genre.name);

    return {
      id: group.id,
      number: group.number,
      description: group.description,
      city_state: group.cities
        ? `${group.cities.name}, ${group.cities.uf}`
        : "",
      photo_url: resolvePhotoUrl(group.photos?.url),
      genres: genres.map(({ id, name }) => ({ id, name })),
      participant_count: info.participantCount(group.id),
      membership_status: info.membershipStatus(group.id),
    };
  });

  const search = normalize(filters.search);
  const matches = items.filter((item) =>
    (!search ||
      normalize(`grupo ${item.number} ${item.description}`).includes(search)) &&
    (!filters.genreId ||
      item.genres.some((genre) => genre.id === filters.genreId)) &&
    (filters.minParticipants === null ||
      item.participant_count >= filters.minParticipants) &&
    (filters.maxParticipants === null ||
      item.participant_count <= filters.maxParticipants)
  );

  return Response.json({
    items: matches.slice(from, to + 1),
    total: matches.length,
    genres: [...genreOptions]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
  });
}));

function readFilters(url: URL): Filters | Response {
  const search = url.searchParams.get("search") ?? "";
  if (search.length > 100) return badRequest('"search" too long');

  const genreId = url.searchParams.get("genreId");
  if (genreId !== null && !isUuid(genreId)) {
    return badRequest('missing/invalid "genreId"');
  }

  const groupId = url.searchParams.get("groupId");
  if (groupId !== null && !isUuid(groupId)) {
    return badRequest('missing/invalid "groupId"');
  }

  const minParticipants = readCount(url, "minParticipants");
  if (minParticipants instanceof Response) return minParticipants;
  const maxParticipants = readCount(url, "maxParticipants");
  if (maxParticipants instanceof Response) return maxParticipants;

  if (
    minParticipants !== null && maxParticipants !== null &&
    minParticipants > maxParticipants
  ) {
    return badRequest('"minParticipants" must not exceed "maxParticipants"');
  }

  return { search, genreId, groupId, minParticipants, maxParticipants };
}

function readCount(url: URL, key: string): number | null | Response {
  const value = url.searchParams.get(key);
  if (value === null || value === "") return null;
  if (!/^\d{1,4}$/.test(value)) return badRequest(`invalid "${key}"`);
  return Number(value);
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}
