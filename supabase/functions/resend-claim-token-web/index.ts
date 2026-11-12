import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import { sendApprovalEmail } from "../_shared/approvalEmail.ts";
import {
  claimTokenExpiresAt,
  generateClaimToken,
} from "../_shared/claimToken.ts";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { readPendingUserId } from "../_shared/pendingUser.ts";

type Ctx = SupabaseContext<Database>;

// Gera um código de ativação novo para uma solicitação aprovada que ainda não
// foi resgatada e reenvia o e-mail. Body JSON: { pending_user_id }.
//
// O UPDATE filtra pelo código anterior: dois cliques simultâneos geram um
// código e um e-mail só. Se o envio falhar, o código anterior volta, para que o
// próximo clique encontre o mesmo estado.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const pendingUserId = await readPendingUserId(req);
  if (pendingUserId instanceof Response) return pendingUserId;

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const { data: current, error: fetchError } = await ctx.supabaseAdmin
    .from("pending_users")
    .select(
      "id, is_approved, token_used_at, claim_token, claim_token_expires_at",
    )
    .eq("id", pendingUserId)
    .maybeSingle();

  if (fetchError) {
    console.error(
      "resend-claim-token-web fetch error",
      oneLine(fetchError.message),
    );
    return serverError("Could not resend the claim token");
  }

  if (!current) {
    return Response.json({ error: "pending user not found" }, { status: 404 });
  }

  if (!current.is_approved || !current.claim_token) {
    return Response.json({ error: "pending user not approved" }, {
      status: 409,
    });
  }

  if (current.token_used_at) {
    return Response.json({ error: "claim token already used" }, {
      status: 409,
    });
  }

  const claimToken = generateClaimToken();
  const { data: updated, error: updateError } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({
      claim_token: claimToken,
      claim_token_expires_at: claimTokenExpiresAt(),
    })
    .eq("id", pendingUserId)
    .eq("is_approved", true)
    .is("token_used_at", null)
    .eq("claim_token", current.claim_token)
    .select("id, name, email");

  if (updateError) {
    console.error(
      "resend-claim-token-web update error",
      oneLine(updateError.message),
    );
    return serverError("Could not resend the claim token");
  }

  const reissued = updated[0];
  if (!reissued) {
    return Response.json({ error: "pending user changed, try again" }, {
      status: 409,
    });
  }

  const email = await sendApprovalEmail({
    to: reissued.email,
    name: reissued.name,
    claimToken,
  });
  if (!email.sent) {
    console.error("resend-claim-token-web email error", oneLine(email.error));
    return await restorePreviousToken(ctx, pendingUserId, claimToken, current);
  }

  return Response.json({ ok: true });
}));

async function restorePreviousToken(
  ctx: Ctx,
  pendingUserId: string,
  claimToken: string,
  previous: { claim_token: string; claim_token_expires_at: string | null },
): Promise<Response> {
  const { data: restored, error } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({
      claim_token: previous.claim_token,
      claim_token_expires_at: previous.claim_token_expires_at,
    })
    .eq("id", pendingUserId)
    .eq("claim_token", claimToken)
    .eq("is_approved", true)
    .is("token_used_at", null)
    .select("id");

  if (error || restored.length === 0) {
    if (error) {
      console.error(
        "resend-claim-token-web restore error",
        oneLine(error.message),
      );
    }
    console.error(
      "resend-claim-token-web restore failed: claim token rotated without an email",
      pendingUserId,
    );
    return serverError(
      "Could not send the email and the previous claim token is no longer valid",
    );
  }

  return serverError("Could not send the email");
}

const serverError = (message: string) =>
  Response.json({ error: message }, { status: 500 });
