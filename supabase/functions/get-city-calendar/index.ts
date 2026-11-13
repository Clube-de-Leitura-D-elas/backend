import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { toLocalDate } from "../_shared/date.ts";
import { readDateRangeParams } from "../_shared/dateRange.ts";
import {
  loadDiscoveryReader,
  loadGroupDiscoveryInfo,
} from "../_shared/groupDiscovery.ts";
import { readNeighborhood } from "../_shared/location.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

// Uma grade mensal tem no máximo 6 semanas.
const MAX_RANGE_DAYS = 42;

type GroupRow = {
  id: string;
  number: number;
  cities: { name: string; uf: string } | null;
  photos: { url: string } | null;
};

type MeetingRow = {
  id: string;
  group_id: string;
  date: string;
  status: string;
  locations: { name: string; address: string | null } | null;
  host: { users: { name: string } } | null;
};

// Encontros dos grupos ativos da cidade da leitora entre `from` e `to`
// (YYYY-MM-DD, datas de São Paulo, inclusivas), com a situação dela em cada
// grupo. O app monta o mês e os filtros "Próximos"/"Passados" a partir daqui.
//
// Quem não é membro do grupo vê só o bairro (o local pode ser a casa da
// anfitriã) e não vê o nome da anfitriã nem encontros em rascunho (CREATED);
// o resto fica como em get-meeting-details, que exige ser membro.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const range = readDateRangeParams(new URL(req.url), {
    maxDays: MAX_RANGE_DAYS,
  });
  if (range instanceof Response) return range;

  const reader = await loadDiscoveryReader(ctx, "get-city-calendar");
  if (reader instanceof Response) return reader;

  const { data: groupsData, error: groupsError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id, number, cities(name, uf), photos(url)")
    .eq("city_id", reader.cityId)
    .eq("is_active", true);

  if (groupsError) {
    console.error("get-city-calendar groups", oneLine(groupsError.message));
    return serverError();
  }

  const groups = (groupsData ?? []) as unknown as GroupRow[];
  if (groups.length === 0) return Response.json({ meetings: [] });

  const groupById = new Map(groups.map((group) => [group.id, group]));

  // Margem de um dia em UTC dos dois lados; o recorte exato é pela data local.
  const queryFrom = new Date(`${range.from}T00:00:00Z`);
  queryFrom.setUTCDate(queryFrom.getUTCDate() - 1);
  const queryUntil = new Date(`${range.to}T00:00:00Z`);
  queryUntil.setUTCDate(queryUntil.getUTCDate() + 2);

  const { data: meetingsData, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, date, status, locations(name, address), host:group_users!meetings_host_id_fkey(users(name))",
    )
    .in("group_id", [...groupById.keys()])
    .not("date", "is", null)
    .gte("date", queryFrom.toISOString())
    .lt("date", queryUntil.toISOString())
    .order("date", { ascending: true })
    .order("id", { ascending: true });

  if (meetingsError) {
    console.error(
      "get-city-calendar meetings",
      oneLine(meetingsError.message),
    );
    return serverError();
  }

  const info = await loadGroupDiscoveryInfo(
    ctx,
    reader.profileId,
    [...groupById.keys()],
    "get-city-calendar",
  );
  if (info instanceof Response) return info;

  const meetings = ((meetingsData ?? []) as unknown as MeetingRow[])
    .map((meeting) => ({ meeting, localDate: toLocalDate(meeting.date) }))
    .filter(({ meeting, localDate }) =>
      localDate !== null && localDate >= range.from &&
      localDate <= range.to &&
      (meeting.status !== "CREATED" ||
        info.membershipStatus(meeting.group_id) === "MEMBER")
    );

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    groups.map((group) => group.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    meetings: meetings.map(({ meeting, localDate }) => {
      const group = groupById.get(meeting.group_id)!;
      const isMember = info.membershipStatus(group.id) === "MEMBER";
      const location = meeting.locations;
      return {
        id: meeting.id,
        date: meeting.date,
        local_date: localDate,
        status: meeting.status,
        location: location
          ? {
            name: isMember ? location.name : null,
            address: isMember ? location.address : null,
            neighborhood: readNeighborhood(location.address),
          }
          : null,
        host_name: isMember ? meeting.host?.users?.name ?? null : null,
        group: {
          id: group.id,
          number: group.number,
          city_state: group.cities
            ? `${group.cities.name}, ${group.cities.uf}`
            : "",
          photo_url: resolvePhotoUrl(group.photos?.url),
          participant_count: info.participantCount(group.id),
          membership_status: info.membershipStatus(group.id),
        },
      };
    }),
  });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to load calendar" }, { status: 500 });
}
