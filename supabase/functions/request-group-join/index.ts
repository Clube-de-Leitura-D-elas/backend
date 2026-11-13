import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const RPC_ERRORS: Record<string, { status: number; error: string }> = {
  GJ001: { status: 404, error: "group not found" },
  GJ003: { status: 409, error: "already requested or member" },
  GJ007: { status: 403, error: "inactive account" },
  GJ008: { status: 409, error: "group has no coordinator" },
};

// Pedido de entrada da leitora autenticada num grupo. A regra (transições,
// aviso às coordenadoras) fica em request_group_join.
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

  const groupId = body?.group_id;
  if (!isUuid(groupId)) {
    return Response.json({ error: 'missing/invalid "group_id"' }, {
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
    console.error("request-group-join profile", oneLine(profileError.message));
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { error } = await ctx.supabaseAdmin.rpc("request_group_join", {
    p_user_id: profile.id,
    p_group_id: groupId,
  });

  if (error) {
    const known = error.code ? RPC_ERRORS[error.code] : undefined;
    if (known) {
      return Response.json({ error: known.error }, { status: known.status });
    }
    console.error("request-group-join rpc", oneLine(error.message));
    return serverError();
  }

  return Response.json({ registration_status: "REQUESTED" }, { status: 201 });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to request group join" }, {
    status: 500,
  });
}
