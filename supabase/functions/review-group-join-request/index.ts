import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const ACTIONS = { approve: true, reject: false } as const;

const RPC_ERRORS: Record<string, { status: number; error: string }> = {
  GJ004: { status: 404, error: "request not found" },
  GJ006: { status: 409, error: "request already reviewed" },
  GJ009: { status: 409, error: "request no longer valid" },
};

// Coordenadora aprova ou recusa um pedido de entrada. Autorização, transição e
// aviso à leitora ficam em review_group_join_request, sob o lock do pedido.
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

  const groupUserId = body?.group_user_id;
  if (!isUuid(groupUserId)) {
    return Response.json({ error: 'missing/invalid "group_user_id"' }, {
      status: 400,
    });
  }

  const action = body?.action;
  if (action !== "approve" && action !== "reject") {
    return Response.json({
      error: 'missing/invalid "action" (expected approve or reject)',
    }, { status: 400 });
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
      "review-group-join-request profile",
      oneLine(profileError.message),
    );
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: status, error } = await ctx.supabaseAdmin.rpc(
    "review_group_join_request",
    {
      p_group_user_id: groupUserId,
      p_reviewer_user_id: profile.id,
      p_approve: ACTIONS[action],
    },
  );

  if (error) {
    const known = error.code ? RPC_ERRORS[error.code] : undefined;
    if (known) {
      return Response.json({ error: known.error }, { status: known.status });
    }
    console.error("review-group-join-request rpc", oneLine(error.message));
    return serverError();
  }

  return Response.json({ registration_status: status });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to review group join request" }, {
    status: 500,
  });
}
