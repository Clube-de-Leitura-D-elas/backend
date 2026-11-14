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

// Aprova uma solicitação pelo painel web. Body JSON: { pending_user_id }.
//
// A aprovação é tudo-ou-nada: marca `is_approved`, gera o código de ativação e
// envia o e-mail na mesma requisição. Se o envio falhar, desfaz a aprovação e
// responde 500 — o painel nunca vê uma solicitação aprovada cujo código não
// chegou por e-mail.
//
// O `WHERE is_approved = false` do UPDATE é a trava: dois cliques simultâneos
// geram um código e um e-mail só. O desfazer confere o `claim_token` gravado
// antes de reverter, para não desfazer uma aprovação concorrente.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const pendingUserId = await readPendingUserId(req);
  if (pendingUserId instanceof Response) return pendingUserId;

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const claimToken = generateClaimToken();
  const expiresAt = claimTokenExpiresAt();

  const { data: updated, error } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({
      is_approved: true,
      claim_token: claimToken,
      claim_token_expires_at: expiresAt,
    })
    .eq("id", pendingUserId)
    .eq("is_approved", false)
    .select("id, name, email, claim_token");

  if (error) {
    console.error("accept-pending-user update error", oneLine(error.message));
    return serverError("Could not approve the request");
  }

  const approved = updated[0];
  if (!approved) return await alreadyApproved(ctx, pendingUserId);

  const email = await sendApprovalEmail({
    to: approved.email,
    name: approved.name,
    claimToken: approved.claim_token,
  });
  if (!email.sent) {
    console.error("accept-pending-user email error", oneLine(email.error));
    return await revertApproval(ctx, pendingUserId, claimToken);
  }

  return Response.json({ ok: true, already_approved: false });
}));

// O envio do e-mail falhou: devolve a solicitação para pendente. O filtro pelo
// `claim_token` garante que só desfazemos a linha que este request aprovou.
async function revertApproval(
  ctx: Ctx,
  pendingUserId: string,
  claimToken: string,
): Promise<Response> {
  const { data: reverted, error } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({
      is_approved: false,
      claim_token: null,
      claim_token_expires_at: null,
    })
    .eq("id", pendingUserId)
    .eq("claim_token", claimToken)
    .eq("is_approved", true)
    .select("id");

  // Sem o desfazer a linha fica aprovada sem código entregue: loga o id para
  // dar para corrigir na mão, já que o painel só vê uma mensagem genérica.
  if (error || reverted.length === 0) {
    if (error) {
      console.error("accept-pending-user revert error", oneLine(error.message));
    }
    console.error(
      "accept-pending-user revert failed: pending user may be approved without an email",
      pendingUserId,
    );
    return serverError(
      "Could not send the approval email and could not revert the approval",
    );
  }

  return serverError("Could not send the approval email");
}

// Nada foi atualizado: ou a solicitação não existe, ou já estava aprovada.
// Não envia e-mail de novo — o código já enviado continua valendo.
async function alreadyApproved(
  ctx: Ctx,
  pendingUserId: string,
): Promise<Response> {
  const { data: existing, error } = await ctx.supabaseAdmin
    .from("pending_users")
    .select("id")
    .eq("id", pendingUserId)
    .maybeSingle();

  if (error) {
    console.error("accept-pending-user fetch error", oneLine(error.message));
    return serverError("Could not approve the request");
  }

  if (!existing) {
    return Response.json({ error: "pending user not found" }, { status: 404 });
  }

  return Response.json({ ok: true, already_approved: true });
}

const serverError = (message: string) =>
  Response.json({ error: message }, { status: 500 });
