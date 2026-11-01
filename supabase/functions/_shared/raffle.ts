import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { oneLine } from "./log.ts";
import { resolveProfilePhotoUrls } from "./profilePhoto.ts";
import { isUuid } from "./uuid.ts";

type Ctx = SupabaseContext<Database>;

export const NO_SUGGESTION_REASON = "Sem indicação de livro";
export const BOOK_ALREADY_DRAWN_REASON =
  "Livro indicado já foi sorteado no grupo";
export const CURRENT_HOST_REASON = "Anfitriã deste encontro";

export type RaffleBook = {
  suggestionId: string;
  bookId: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
};

export type RaffleCandidate = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  book: RaffleBook | null;
  exclusionReason: string | null;
};

type MemberRow = {
  id: string;
  user_id: string;
  users: { name: string; is_active: boolean; photos: { url: string } | null };
};

type SuggestionRow = {
  id: string;
  group_user_id: string;
  book_id: string;
  books: {
    name: string;
    author: string | null;
    photos: { url: string } | null;
  } | null;
};

// `host_id` é o id do vínculo em group_users, não o user_id.
type HostRow = { host_id: string; date: string | null };

type GroupLinks = {
  activeUserIds: string[];
  userIdByLink: Map<string, string>;
};

/**
 * Participantes do sorteio: quem teve presença registrada no encontro e segue
 * ativa no grupo. Cada uma concorre com a indicação disponível mais recente
 * cujo livro ainda não foi sorteado nem lido no grupo; quem não tem fica na
 * lista com o motivo da exclusão. A anfitriã do próprio encontro nunca
 * concorre a ele.
 *
 * O rodízio de anfitriãs não filtra esta lista: ele só limita quem pode ser
 * escolhida no sorteio (ver `narrowByHostRotation`).
 */
export async function loadRaffleCandidates(
  ctx: Ctx,
  req: Request,
  meetingId: string,
  groupId: string,
  logLabel: string,
): Promise<RaffleCandidate[] | Response> {
  const admin = ctx.supabaseAdmin;

  const { data: present, error: presentError } = await admin
    .from("meeting_users")
    .select("user_id")
    .eq("meeting_id", meetingId)
    .eq("presence_status", "PRESENT");
  if (presentError) return dbError(logLabel, "presence", presentError);

  const presentIds = (present ?? []).map((row: { user_id: string }) =>
    row.user_id
  );
  if (presentIds.length === 0) return [];

  const { data: memberData, error: memberError } = await admin
    .from("group_users")
    .select("id, user_id, users!inner(name, is_active, photos(url))")
    .eq("group_id", groupId)
    .eq("registration_status", "ACTIVE")
    .eq("users.is_active", true)
    .in("user_id", presentIds);
  if (memberError) return dbError(logLabel, "members", memberError);
  const memberRows = (memberData ?? []) as unknown as MemberRow[];
  if (memberRows.length === 0) return [];

  // group_users não tem UNIQUE (group_id, user_id): uma leitora pode ter mais
  // de um vínculo, e as indicações ficam presas a cada um.
  const members = new Map<string, { row: MemberRow; linkIds: Set<string> }>();
  for (const row of memberRows) {
    const member = members.get(row.user_id);
    if (member) member.linkIds.add(row.id);
    else members.set(row.user_id, { row, linkIds: new Set([row.id]) });
  }

  const { data: suggestionData, error: suggestionError } = await admin
    .from("book_suggestions")
    .select("id, group_user_id, book_id, books(name, author, photos(url))")
    .in("group_user_id", memberRows.map((row) => row.id))
    .eq("book_status", "AVAILABLE")
    .order("suggested_at", { ascending: false });
  if (suggestionError) return dbError(logLabel, "suggestions", suggestionError);
  const suggestions = (suggestionData ?? []) as unknown as SuggestionRow[];

  const usedBooks = await findGroupUsedBooks(ctx, groupId, logLabel);
  if (usedBooks instanceof Response) return usedBooks;

  const currentHostId = await findMeetingHostUserId(ctx, meetingId, logLabel);
  if (currentHostId instanceof Response) return currentHostId;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    memberRows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return [...members.values()]
    .map(({ row, linkIds }) => {
      const own = suggestions.filter((s) => linkIds.has(s.group_user_id));
      const available = own.find((s) => !usedBooks.has(s.book_id));
      const isCurrentHost = row.user_id === currentHostId;
      const book = isCurrentHost ? undefined : available;
      return {
        userId: row.user_id,
        name: row.users.name,
        avatarUrl: resolvePhotoUrl(row.users.photos?.url),
        book: book ? toRaffleBook(book) : null,
        exclusionReason: isCurrentHost
          ? CURRENT_HOST_REASON
          : book
          ? null
          : own.length > 0
          ? BOOK_ALREADY_DRAWN_REASON
          : NO_SUGGESTION_REASON,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/**
 * Rodízio de anfitriãs, aplicado só na escolha da vencedora: dentre as
 * participantes marcadas, quem já foi anfitriã só pode ser escolhida de novo
 * depois que todas as outras integrantes ativas do grupo (presentes ou não)
 * tiverem sido anfitriãs depois dela. Quem nunca foi anfitriã não é limitada.
 * O histórico conta só encontros já realizados e o encontro atual.
 *
 * Se todas as marcadas estiverem bloqueadas, vale a exceção: a que está há
 * mais tempo sem hospedar. Se só restar quem hospedou por último, ela é
 * escolhida mesmo assim, porque quem está presente tem prioridade. Nunca
 * devolve uma lista vazia quando `picked` não é vazia.
 */
export async function narrowByHostRotation(
  ctx: Ctx,
  meetingId: string,
  groupId: string,
  logLabel: string,
  picked: RaffleCandidate[],
): Promise<RaffleCandidate[] | Response> {
  const hosts = await findGroupHosts(ctx, meetingId, groupId, logLabel);
  if (hosts instanceof Response) return hosts;

  const links = await findGroupLinks(ctx, groupId, logLabel);
  if (links instanceof Response) return links;

  // Traduz o id do vínculo (host_id) para o user_id.
  const hostedBy = hosts.flatMap((h) => {
    const userId = links.userIdByLink.get(h.host_id);
    return userId ? [{ host_id: userId, date: h.date }] : [];
  });

  const lastHostedAt = lastHostedAtByUser(links.activeUserIds, hostedBy);
  const blocked = blockedFromLastHosted(links.activeUserIds, lastHostedAt);

  const allowed = picked.filter((c) => !blocked.has(c.userId));
  if (allowed.length > 0) return allowed;

  const released = findRotationFallbackUserIds(
    picked.map((c) => c.userId),
    lastHostedAt,
  );
  const fallback = picked.filter((c) => released.has(c.userId));
  return fallback.length > 0 ? fallback : picked;
}

// Livros que não podem sair de novo no grupo: os já sorteados e os já lidos
// em algum encontro (os encontros antigos não têm indicação DRAWN ligada).
async function findGroupUsedBooks(
  ctx: Ctx,
  groupId: string,
  logLabel: string,
): Promise<Set<string> | Response> {
  const { data: drawn, error: drawnError } = await ctx.supabaseAdmin
    .from("book_suggestions")
    .select("book_id")
    .eq("group_id", groupId)
    .neq("book_status", "AVAILABLE");
  if (drawnError) return dbError(logLabel, "drawn books", drawnError);

  const { data: meetings, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("book_id")
    .eq("group_id", groupId);
  if (meetingsError) return dbError(logLabel, "meeting books", meetingsError);

  return new Set(
    [...(drawn ?? []), ...(meetings ?? [])].map((row: { book_id: string }) =>
      row.book_id
    ),
  );
}

// Anfitriã do encontro em que o sorteio acontece, como user_id.
async function findMeetingHostUserId(
  ctx: Ctx,
  meetingId: string,
  logLabel: string,
): Promise<string | null | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("host:group_users!meetings_host_id_fkey(user_id)")
    .eq("id", meetingId)
    .maybeSingle();
  if (error) return dbError(logLabel, "meeting host", error);
  return (data as { host: { user_id: string } | null } | null)?.host
    ?.user_id ?? null;
}

// Encontros que já aconteceram (ENDED/CONCLUDED) mais o encontro atual, para
// saber quem foi anfitriã e quando. Encontros futuros ainda não contam.
async function findGroupHosts(
  ctx: Ctx,
  meetingId: string,
  groupId: string,
  logLabel: string,
): Promise<HostRow[] | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("host_id, date")
    .eq("group_id", groupId)
    .not("date", "is", null)
    .or(`status.in.(ENDED,CONCLUDED),id.eq.${meetingId}`);
  if (error) return dbError(logLabel, "meeting hosts", error);
  return (data ?? []) as HostRow[];
}

// Vínculos do grupo: `activeUserIds` são as integrantes ativas, presentes ou
// não (todas entram na conta do rodízio); `userIdByLink` traduz o id do
// vínculo para o user_id, inclusive de vínculos antigos ou inativos.
async function findGroupLinks(
  ctx: Ctx,
  groupId: string,
  logLabel: string,
): Promise<GroupLinks | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id, user_id, registration_status, users!inner(is_active)")
    .eq("group_id", groupId);
  if (error) return dbError(logLabel, "group members", error);

  const rows = (data ?? []) as {
    id: string;
    user_id: string;
    registration_status: string;
    users: { is_active: boolean };
  }[];
  const active = rows
    .filter((r) => r.registration_status === "ACTIVE" && r.users.is_active)
    .map((r) => r.user_id);
  return {
    activeUserIds: [...new Set(active)],
    userIdByLink: new Map(rows.map((r) => [r.id, r.user_id])),
  };
}

/** Timestamp da hospedagem mais recente de cada integrante do pool. */
function lastHostedAtByUser(
  poolUserIds: string[],
  meetings: HostRow[],
): Map<string, number> {
  const pool = new Set(poolUserIds);
  const lastHostedAt = new Map<string, number>();
  for (const meeting of meetings) {
    if (!meeting.date || !pool.has(meeting.host_id)) continue;
    const time = Date.parse(meeting.date);
    if (Number.isNaN(time)) continue;
    const previous = lastHostedAt.get(meeting.host_id);
    if (previous === undefined || time > previous) {
      lastHostedAt.set(meeting.host_id, time);
    }
  }
  return lastHostedAt;
}

/**
 * Quem já foi anfitriã fica bloqueada enquanto alguma outra integrante do
 * pool ainda não hospedou depois dela. Quem nunca foi anfitriã não é
 * bloqueada.
 */
function blockedFromLastHosted(
  poolUserIds: string[],
  lastHostedAt: Map<string, number>,
): Set<string> {
  const blocked = new Set<string>();
  for (const [userId, hostedAt] of lastHostedAt) {
    const someoneBehind = poolUserIds.some((other) =>
      other !== userId && (lastHostedAt.get(other) ?? -Infinity) < hostedAt
    );
    if (someoneBehind) blocked.add(userId);
  }
  return blocked;
}

/**
 * Exceção do rodízio: quando todas as candidatas estão bloqueadas, libera a
 * que está há mais tempo sem hospedar, sem considerar a anfitriã mais recente
 * do grupo. Se só ela sobrar, quem chama decide (ver `narrowByHostRotation`).
 */
function findRotationFallbackUserIds(
  blockedCandidateIds: string[],
  lastHostedAt: Map<string, number>,
): Set<string> {
  if (lastHostedAt.size === 0) return new Set();
  const mostRecent = Math.max(...lastHostedAt.values());
  const releasable = blockedCandidateIds.filter((id) =>
    (lastHostedAt.get(id) ?? Infinity) < mostRecent
  );
  if (releasable.length === 0) return new Set();
  const oldest = Math.min(...releasable.map((id) => lastHostedAt.get(id)!));
  return new Set(releasable.filter((id) => lastHostedAt.get(id) === oldest));
}

function toRaffleBook(row: SuggestionRow): RaffleBook {
  return {
    suggestionId: row.id,
    bookId: row.book_id,
    title: row.books?.name ?? "",
    author: row.books?.author ?? null,
    coverUrl: row.books?.photos?.url ?? null,
  };
}

export const isEligible = (candidate: RaffleCandidate) =>
  candidate.book !== null;

export function toParticipantJson(candidate: RaffleCandidate) {
  return {
    id: candidate.userId,
    name: candidate.name,
    avatar_url: candidate.avatarUrl,
    has_attended: true,
    is_excluded_by_rule: !isEligible(candidate),
    exclusion_reason: candidate.exclusionReason,
    book_title: candidate.book?.title ?? null,
    book_author: candidate.book?.author ?? null,
    book_cover_url: candidate.book?.coverUrl ?? null,
  };
}

export function toResultJson(
  meetingId: string,
  candidate: RaffleCandidate,
  drawnAt: string | null,
) {
  return {
    meeting_id: meetingId,
    winner_id: candidate.userId,
    winner_name: candidate.name,
    winner_avatar_url: candidate.avatarUrl,
    book_title: candidate.book?.title ?? "",
    book_author: candidate.book?.author ?? null,
    book_cover_url: candidate.book?.coverUrl ?? null,
    drawn_at: drawnAt,
  };
}

export async function readJsonBody(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // cai no 400 abaixo
  }
  return Response.json({ error: "expected JSON body" }, { status: 400 });
}

export function readMeetingId(
  body: Record<string, unknown>,
): string | Response {
  const meetingId = body.meeting_id;
  if (!isUuid(meetingId)) {
    return badRequest('missing/invalid "meeting_id"');
  }
  return meetingId.toLowerCase();
}

export function readParticipantIds(
  body: Record<string, unknown>,
): string[] | Response {
  const ids = body.eligible_participant_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) {
    return badRequest('missing/invalid "eligible_participant_ids"');
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/**
 * Cruza os ids enviados pelo app com os elegíveis do servidor: todos precisam
 * estar presentes e com indicação válida.
 */
export function pickEligible(
  candidates: RaffleCandidate[],
  ids: string[],
): RaffleCandidate[] | Response {
  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const picked = ids.map((id) => byId.get(id));
  if (picked.some((c) => !c || !isEligible(c))) {
    return Response.json({
      error: "some participants are not eligible for this raffle",
    }, { status: 422 });
  }
  return picked as RaffleCandidate[];
}

export async function hasRaffleResult(
  ctx: Ctx,
  meetingId: string,
  logLabel: string,
): Promise<boolean | Response> {
  const { count, error } = await ctx.supabaseAdmin
    .from("meeting_raffles")
    .select("meeting_id", { count: "exact", head: true })
    .eq("meeting_id", meetingId);
  if (error) return dbError(logLabel, "raffle lookup", error);
  return (count ?? 0) > 0;
}

export const raffleAlreadyRecorded = () =>
  Response.json({ error: "raffle already recorded for this meeting" }, {
    status: 409,
  });

export function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function dbError(
  logLabel: string,
  step: string,
  error: { message: string },
): Response {
  console.error(`${logLabel} ${step} error`, oneLine(error.message));
  return Response.json({ error: "Unable to load raffle data" }, {
    status: 500,
  });
}

/** Índice uniforme com crypto, sem o viés do módulo. */
export function randomIndex(length: number): number {
  const limit = Math.floor(0x1_0000_0000 / length) * length;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % length;
}