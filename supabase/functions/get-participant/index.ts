import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { readParticipantIdParam } from "../_shared/participant.ts";

type ParticipantRow = {
  id: string;
  name: string;
  phone: string;
  instagram: string | null;
  email: string;
  birth_date: string;
  job: string | null;
  is_active: boolean;
  cities: { name: string } | null;
  zones: { name: string } | null;
};

// Dados do perfil de uma participante. Query string: participant_id.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const participantId = readParticipantIdParam(new URL(req.url));
  if (participantId instanceof Response) return participantId;

  const { data, error } = await ctx.supabaseAdmin
    .from("users")
    .select(
      "id, name, phone, instagram, email, birth_date, job, is_active, cities(name), zones(name)",
    )
    .eq("id", participantId)
    .maybeSingle();

  if (error) {
    console.error("get-participant error", error);
    return Response.json({ error: error.message }, { status: 400 });
  }

  if (!data) {
    return Response.json({ error: "participant not found" }, { status: 404 });
  }

  const { cities, zones, ...participant } = data as unknown as ParticipantRow;

  return Response.json({
    ...participant,
    city: cities?.name ?? null,
    zone: zones?.name ?? null,
  });
}));
