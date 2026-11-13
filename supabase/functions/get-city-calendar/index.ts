import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { toLocalDate } from "../_shared/date.ts";
import { readDateRangeParams } from "../_shared/dateRange.ts";
import {
  loadDiscoveryReader,
  loadGroupDiscoveryInfo,
  readCityFilter,
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

type GuestStatus = "REQUESTED" | "ACCEPTED" | "REJECTED";

type MeetingRow = {
  id: string;
  group_id: string;
  date: string;
  status: string;
  locations: { name: string; address: string | null } | null;
  host: { users: { name: string } } | null;
};

// Encontros dos grupos ativos entre `from` e `to` (YYYY-MM-DD, datas de São
// Paulo, inclusivas), com a situação da leitora em cada grupo. `cityId` recorta
// a cidade (veja readCityFilter). O app monta o mês e os filtros
// "Próximos"/"Passados" a partir daqui.
//
// Quem não é membro do grupo vê só o bairro (o local pode ser a casa da
// anfitriã) e não vê o nome da anfitriã nem encontros em rascunho (CREATED);
// o resto fica como em get-meeting-details, que exige ser membro.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const url = new URL(req.url);
  const range = readDateRangeParams(url, { maxDays: MAX_RANGE_DAYS });
  if (range instanceof Response) return range;
  const cityFilter = readCityFilter(url);
  if (cityFilter instanceof Response) return cityFilter;

  const reader = await loadDiscoveryReader(ctx, "get-city-calendar");
  if (reader instanceof Response) return reader;

  const cityId = cityFilter(reader);
  let groupsQuery = ctx.supabaseAdmin
    .from("groups")
    .select("id, number, cities(name, uf), photos(url)")
    .eq("is_active", true);
  if (cityId) groupsQuery = groupsQuery.eq("city_id", cityId);
  const { data: groupsData, error: groupsError } = await groupsQuery;

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

  const guests = await loadGuestStatuses(
    ctx,
    reader.profileId,
    meetings.map(({ meeting }) => meeting.id),
  );
  if (guests instanceof Response) return guests;

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
      const hasGroupLink = info.hasGroupLink(group.id);
      const storedGuestStatus = guests.statuses.get(meeting.id) ?? null;
      // Pedido de convidada de quem depois passou a ter vínculo com o grupo
      // não pode mais ser aceito e some da lista da anfitriã; não fica
      // "aguardando" para sempre.
      const meetingGuestStatus = isMember ||
          (hasGroupLink && storedGuestStatus === "REQUESTED")
        ? null
        : storedGuestStatus;
      // Convidada aceita vai ao encontro: vê local e anfitriã como membro.
      const seesDetails = isMember || meetingGuestStatus === "ACCEPTED";
      const location = meeting.locations;
      // Espelha as regras de request_meeting_participation que o app não
      // enxerga: qualquer vínculo bloqueia (mesmo os que não viram status),
      // assim como linha em meeting_users e recusa nas últimas 24h.
      const canRequestParticipation = !hasGroupLink &&
        !guests.blocked.has(meeting.id) &&
        meeting.status === "SCHEDULED" &&
        new Date(meeting.date).getTime() > Date.now() &&
        (meetingGuestStatus === null || meetingGuestStatus === "REJECTED");
      return {
        id: meeting.id,
        date: meeting.date,
        local_date: localDate,
        status: meeting.status,
        location: location
          ? {
            name: seesDetails ? location.name : null,
            address: seesDetails ? location.address : null,
            neighborhood: readNeighborhood(location.address),
          }
          : null,
        host_name: seesDetails ? meeting.host?.users?.name ?? null : null,
        guest_status: meetingGuestStatus,
        can_request_participation: canRequestParticipation,
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

// Mesma espera do RPC (MG011) para pedir de novo depois de uma recusa.
const REQUEST_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Situação da leitora como convidada em cada encontro, só pelo pedido de
 * participação. Uma linha em meeting_users não basta: ex-participante ainda
 * consegue gravar a própria resposta e veria o endereço sem aprovação. Essa
 * linha (e a recusa recente) só bloqueia um pedido novo, como no RPC.
 */
async function loadGuestStatuses(
  ctx: SupabaseContext<Database>,
  profileId: string,
  meetingIds: string[],
): Promise<
  { statuses: Map<string, GuestStatus>; blocked: Set<string> } | Response
> {
  const statuses = new Map<string, GuestStatus>();
  const blocked = new Set<string>();
  if (meetingIds.length === 0) return { statuses, blocked };

  const [requests, attendances] = await Promise.all([
    ctx.supabaseAdmin
      .from("meeting_guest_requests")
      .select("meeting_id, status, reviewed_at")
      .eq("user_id", profileId)
      .in("meeting_id", meetingIds),
    ctx.supabaseAdmin
      .from("meeting_users")
      .select("meeting_id")
      .eq("user_id", profileId)
      .in("meeting_id", meetingIds),
  ]);

  const error = requests.error ?? attendances.error;
  if (error) {
    console.error("get-city-calendar guests", oneLine(error.message));
    return serverError();
  }

  const now = Date.now();
  for (const row of requests.data ?? []) {
    statuses.set(row.meeting_id, row.status as GuestStatus);
    if (
      row.status === "REJECTED" && row.reviewed_at &&
      now - new Date(row.reviewed_at).getTime() < REQUEST_AGAIN_AFTER_MS
    ) {
      blocked.add(row.meeting_id);
    }
  }
  for (const row of attendances.data ?? []) blocked.add(row.meeting_id);
  return { statuses, blocked };
}

function serverError(): Response {
  return Response.json({ error: "Unable to load calendar" }, { status: 500 });
}
