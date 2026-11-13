import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { NOT_JOINED_FILTER } from "./group.ts";
import { oneLine } from "./log.ts";
import { isUuid } from "./uuid.ts";

type Ctx = SupabaseContext<Database>;

/**
 * Situação da leitora em relação a um grupo, para o app decidir o botão:
 * MEMBER (já participa), REQUESTED (aguardando a coordenadora), REJECTED
 * (recusada, pode pedir de novo), PENDING (aguardando criação de conta) ou
 * null (sem vínculo, ou ex-participante: pode pedir).
 */
export type MembershipStatus =
  | "MEMBER"
  | "REQUESTED"
  | "REJECTED"
  | "PENDING"
  | null;

const STATUS_BY_REGISTRATION: Record<string, MembershipStatus> = {
  ACTIVE: "MEMBER",
  REQUESTED: "REQUESTED",
  REJECTED: "REJECTED",
  PENDING: "PENDING",
};

export type DiscoveryReader = { profileId: string; cityId: string };

/**
 * Parâmetro `cityId` das telas de descoberta: uma cidade, `all` (todas) ou
 * ausente, que fica na cidade da leitora como antes do filtro, para versões
 * do app que não mandam o parâmetro. Devolve o id da cidade, null para todas,
 * ou a função que resolve a ausente a partir da leitora.
 */
export function readCityFilter(
  url: URL,
): ((reader: DiscoveryReader) => string | null) | Response {
  const value = url.searchParams.get("cityId");
  if (value === null) return (reader) => reader.cityId;
  if (value === "all") return () => null;
  if (!isUuid(value)) {
    return Response.json({ error: 'missing/invalid "cityId"' }, {
      status: 400,
    });
  }
  return () => value;
}

export type GroupDiscoveryInfo = {
  participantCount: (groupId: string) => number;
  membershipStatus: (groupId: string) => MembershipStatus;
  /** Qualquer linha em group_users, inclusive status que o app não mostra. */
  hasGroupLink: (groupId: string) => boolean;
};

function dbError(logLabel: string, step: string, message: string): Response {
  console.error(`${logLabel} ${step} error`, oneLine(message));
  return Response.json({ error: "Unable to load data" }, { status: 500 });
}

/**
 * Leitora autenticada e a cidade dela, que recorta o que o app mostra. Conta
 * inativa não descobre grupos (nem conseguiria pedir para entrar).
 */
export async function loadDiscoveryReader(
  ctx: Ctx,
  logLabel: string,
): Promise<DiscoveryReader | Response> {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("users")
    .select("id, city_id, is_active")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) return dbError(logLabel, "profile", error.message);
  if (!data) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }
  if (!data.is_active) {
    return Response.json({ error: "inactive account" }, { status: 403 });
  }

  return { profileId: data.id, cityId: data.city_id };
}

/**
 * Nº de participantes e situação da leitora em cada grupo. A contagem segue a
 * de get-group-details e get-my-groups (todo vínculo menos pedido e recusa),
 * para o número bater entre as telas.
 */
export async function loadGroupDiscoveryInfo(
  ctx: Ctx,
  profileId: string,
  groupIds: string[],
  logLabel: string,
): Promise<GroupDiscoveryInfo | Response> {
  const counts = new Map<string, number>();
  const statuses = new Map<string, MembershipStatus>();

  if (groupIds.length > 0) {
    // Uma contagem por grupo (head), porque trazer as linhas de todos os
    // vínculos da cidade passaria do max_rows do PostgREST e cortaria calado.
    const [mine, ...memberCounts] = await Promise.all([
      ctx.supabaseAdmin
        .from("group_users")
        .select("group_id, registration_status")
        .in("group_id", groupIds)
        .eq("user_id", profileId),
      ...groupIds.map((groupId) =>
        ctx.supabaseAdmin
          .from("group_users")
          .select("id", { count: "exact", head: true })
          .eq("group_id", groupId)
          .not("registration_status", "in", NOT_JOINED_FILTER)
      ),
    ]);

    if (mine.error) return dbError(logLabel, "membership", mine.error.message);
    for (const [index, result] of memberCounts.entries()) {
      if (result.error) {
        return dbError(logLabel, "members", result.error.message);
      }
      counts.set(groupIds[index], result.count ?? 0);
    }
    for (const row of mine.data ?? []) {
      statuses.set(
        row.group_id,
        STATUS_BY_REGISTRATION[row.registration_status] ?? null,
      );
    }
  }

  return {
    participantCount: (groupId) => counts.get(groupId) ?? 0,
    membershipStatus: (groupId) => statuses.get(groupId) ?? null,
    hasGroupLink: (groupId) => statuses.has(groupId),
  };
}
