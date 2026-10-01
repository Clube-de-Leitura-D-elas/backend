import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { toLocalDate } from "../_shared/date.ts";
import { readGroupIdParam, requireExistingGroup } from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { isPresent } from "../_shared/presence.ts";
import { requireRole } from "../_shared/role.ts";

// Quantas bolinhas de presença a coluna "PRESENÇA" mostra por participante.
const ATTENDANCE_MEETINGS = 3;

type ParticipantRow = {
  id: string;
  name: string;
  email: string | null;
  // O filtro por `group_id` no embed com !inner deixa exatamente um vínculo.
  memberships: {
    id: string;
    is_coordinator: boolean;
    created_at: string | null;
  }[];
};

type PresenceRow = {
  meeting_id: string;
  group_user_id: string;
  presence_status: string | null;
};

// Aba "Participantes Cadastradas" da tela de detalhes do grupo (painel web).
// Query string: groupId, page, pageSize.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const url = new URL(req.url);
  const groupId = readGroupIdParam(url, "groupId");
  if (groupId instanceof Response) return groupId;

  const missing = await requireExistingGroup(ctx, groupId);
  if (missing) return missing;

  const { from, to } = parseListParams(url);

  // A lista é ordenada por nome, então a consulta parte de `users` (mesmo
  // recorte de get-participants) e não de `group_users`.
  const { data, error, count } = await ctx.supabaseAdmin
    .from("users")
    .select(
      "id, name, email, memberships:group_users!inner(id, is_coordinator, created_at, group_id)",
      { count: "exact" },
    )
    .eq("memberships.group_id", groupId)
    .order("name", { ascending: true })
    .order("id")
    .range(from, to);

  if (error) {
    console.error("get-group-participants-web error", oneLine(error.message));
    return Response.json({ error: error.message }, { status: 400 });
  }

  const rows = (data ?? []) as unknown as ParticipantRow[];
  const total = count ?? 0;

  if (rows.length === 0) {
    return Response.json({ items: [], total });
  }

  // Últimos encontros realizados do grupo, do mais antigo para o mais recente:
  // a coluna lê da esquerda para a direita na ordem em que aconteceram.
  const { data: meetingData, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, date")
    .eq("group_id", groupId)
    .eq("status", "CONCLUDED")
    .not("date", "is", null)
    .order("date", { ascending: false })
    .limit(ATTENDANCE_MEETINGS);

  if (meetingsError) {
    console.error(
      "get-group-participants-web meetings error",
      oneLine(meetingsError.message),
    );
    return Response.json({ error: meetingsError.message }, { status: 400 });
  }

  const meetingIds = (meetingData ?? []).map((meeting) => meeting.id).reverse();
  const membershipIds = rows
    .map((row) => row.memberships[0]?.id)
    .filter((id): id is string => Boolean(id));

  const marks = new Map<string, "P" | "F">();

  if (meetingIds.length > 0 && membershipIds.length > 0) {
    const { data: presenceData, error: presenceError } = await ctx.supabaseAdmin
      .from("meeting_group_users")
      .select("meeting_id, group_user_id, presence_status")
      .in("meeting_id", meetingIds)
      .in("group_user_id", membershipIds);

    if (presenceError) {
      console.error(
        "get-group-participants-web presence error",
        oneLine(presenceError.message),
      );
      return Response.json({ error: presenceError.message }, { status: 400 });
    }

    for (const row of (presenceData ?? []) as unknown as PresenceRow[]) {
      marks.set(
        `${row.group_user_id}:${row.meeting_id}`,
        isPresent(row.presence_status) ? "P" : "F",
      );
    }
  }

  const items = rows.map((row) => {
    const membership = row.memberships[0];

    return {
      id: row.id,
      name: row.name,
      entry_date: toLocalDate(membership?.created_at),
      // Quem entrou depois não tem registro no encontro: a bolinha fica fora
      // em vez de virar uma falta que não existiu.
      attendance: meetingIds
        .map((meetingId) => marks.get(`${membership?.id}:${meetingId}`))
        .filter((mark): mark is "P" | "F" => mark !== undefined),
      email: row.email,
      is_coordinator: membership?.is_coordinator ?? false,
    };
  });

  return Response.json({ items, total });
}));
