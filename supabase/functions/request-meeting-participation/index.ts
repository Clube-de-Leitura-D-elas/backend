import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const RPC_ERRORS: Record<string, { status: number; error: string }> = {
  MG001: { status: 404, error: "meeting not found" },
  MG002: { status: 409, error: "meeting not open" },
  MG003: { status: 403, error: "meeting not available" },
  MG004: { status: 409, error: "already a member" },
  MG005: { status: 409, error: "already requested" },
  MG007: { status: 403, error: "inactive account" },
  MG008: { status: 409, error: "meeting has no reviewer" },
  MG011: { status: 409, error: "recently rejected" },
};

// Pedido de participação da leitora autenticada num encontro de outro grupo da
// cidade dela. A regra (transições, aviso à anfitriã e às coordenadoras) fica
// em request_meeting_participation.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(
      "request-meeting-participation profile",
      oneLine(profileError.message),
    );
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { error } = await ctx.supabaseAdmin.rpc(
    "request_meeting_participation",
    {
      p_user_id: profile.id,
      p_meeting_id: meetingId,
    },
  );

  if (error) {
    const known = error.code ? RPC_ERRORS[error.code] : undefined;
    if (known) {
      return Response.json({ error: known.error }, { status: known.status });
    }
    console.error("request-meeting-participation rpc", oneLine(error.message));
    return serverError();
  }

  return Response.json({ guest_status: "REQUESTED" }, { status: 201 });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to request meeting participation" }, {
    status: 500,
  });
}
