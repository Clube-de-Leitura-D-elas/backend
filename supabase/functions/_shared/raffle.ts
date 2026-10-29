import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { oneLine } from "./log.ts";
import { isUuid } from "./uuid.ts";

type Ctx = SupabaseContext<Database>;

export const NO_SUGGESTION_REASON = "Sem indicação de livro";
export const BOOK_ALREADY_DRAWN_REASON =
  "Livro indicado já foi sorteado no grupo";

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

/**
 * Participantes do sorteio: quem teve presença registrada no encontro e segue
 * ativa no grupo. Cada uma concorre com a indicação disponível mais recente
 * cujo livro ainda não foi sorteado nem lido no grupo; quem não tem fica na
 * lista com o motivo da exclusão.
 */
export async function loadRaffleCandidates(
  ctx: Ctx,
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

  return [...members.values()]
    .map(({ row, linkIds }) => {
      const own = suggestions.filter((s) => linkIds.has(s.group_user_id));
      const available = own.find((s) => !usedBooks.has(s.book_id));
      return {
        userId: row.user_id,
        name: row.users.name,
        avatarUrl: row.users.photos?.url ?? null,
        book: available ? toRaffleBook(available) : null,
        exclusionReason: available
          ? null
          : own.length > 0
          ? BOOK_ALREADY_DRAWN_REASON
          : NO_SUGGESTION_REASON,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
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
    .select("book_id, group_users!inner(group_id)")
    .eq("group_users.group_id", groupId)
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
