import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { toLocalDate } from "../_shared/date.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";

// Lotes da RPC: uma chamada só pararia no max_rows sem avisar. O max_rows do
// projeto hospedado pode ser menor que o lote, então só um lote vazio indica o
// fim (mesmo cuidado de `get-book-details`).
const BATCH_SIZE = 1000;

type AbsenceRow = {
  user_id: string;
  user_name: string;
  group_id: string;
  group_number: number;
  group_description: string;
  last_presence_at: string | null;
};

type AbsenceItem = {
  participantId: string;
  name: string;
  group: { id: string; number: number; description: string };
  lastPresenceAt: string | null;
};

// Lista "Participantes que faltaram aos últimos 3 encontros" do dashboard do
// painel web. Uma linha por participante + grupo; a regra está na migration
// `dashboard_absences`. Sem paginação: o painel pagina em memória.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const rows: AbsenceRow[] = [];
  for (let offset = 0;;) {
    const { data, error } = await ctx.supabaseAdmin
      .rpc("dashboard_recent_absences")
      .order("user_id")
      .order("group_id")
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error("get-dashboard-absences-web rpc", oneLine(error.message));
      return Response.json({ error: "unable to load absences" }, {
        status: 500,
      });
    }

    const batch = (data ?? []) as AbsenceRow[];
    if (batch.length === 0) break;
    rows.push(...batch);
    offset += batch.length;
  }

  const items: AbsenceItem[] = rows.map((row) => ({
    participantId: row.user_id,
    name: row.user_name,
    group: {
      id: row.group_id,
      number: row.group_number,
      description: row.group_description,
    },
    lastPresenceAt: toLocalDate(row.last_presence_at),
  }));

  // Quem está sumida há mais tempo primeiro: sem presença, depois a data mais
  // antiga; empate por nome e número do grupo.
  items.sort((a, b) =>
    compareLastPresence(a.lastPresenceAt, b.lastPresenceAt) ||
    a.name.localeCompare(b.name, "pt-BR") ||
    a.group.number - b.group.number
  );

  return Response.json({ items });
}));

function compareLastPresence(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
