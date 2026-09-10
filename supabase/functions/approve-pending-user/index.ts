import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { Resend } from "npm:resend@4.0.0";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is required");
const FROM_EMAIL = Deno.env.get("EMAIL_FROM");
if (!FROM_EMAIL) throw new Error("EMAIL_FROM is required");
const APPROVAL_TOKEN_SECRET = Deno.env.get("APPROVAL_TOKEN_SECRET");
if (!APPROVAL_TOKEN_SECRET) throw new Error("APPROVAL_TOKEN_SECRET is required");
const resend = new Resend(RESEND_API_KEY);
function toBase64Url(bytes) {
  const u8 = new Uint8Array(bytes);
  let str = "";
  for (const b of u8)str += String.fromCharCode(b);
  const b64 = btoa(str);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function signToken(pendingUserId) {
  const keyData = new TextEncoder().encode(APPROVAL_TOKEN_SECRET);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(pendingUserId));
  return toBase64Url(sig);
}
Deno.serve(withSupabase({
  auth: "none"
}, async (_req, ctx)=>{
  const url = new URL(_req.url);
  const pendingUserId = url.searchParams.get("pending_user_id");
  const token = url.searchParams.get("token");
  if (!pendingUserId) {
    return new Response("missing pending_user_id", {
      status: 400
    });
  }
  if (token) {
    const expected = await signToken(pendingUserId);
    if (token !== expected) {
      return new Response("invalid token", {
        status: 401
      });
    }
  }
  // Fetch the pending user details (is_approved was already updated in DB)
  const { data: pendingUser, error: fetchError } = await ctx.supabaseAdmin.from("pending_users").select("id, name, email, claim_token, is_approved").eq("id", pendingUserId).single();
  if (fetchError || !pendingUser) {
    console.error("fetch pending_user error", fetchError);
    return new Response(JSON.stringify({
      error: "pending user not found"
    }), {
      status: 404
    });
  }
  if (!pendingUser.email) {
    return new Response("missing email", {
      status: 400
    });
  }
  const claimToken = pendingUser.claim_token;
  const subject = "Seu cadastro foi aprovado! 🎉";
  const text = [
    `Olá ${pendingUser.name ?? ''},`,
    "",
    "Seu cadastro no Clube de Leitura D'Elas foi aprovado!",
    "",
    `Seu Token de Acesso (Claim Token): ${claimToken}`,
    "",
    "Abra o aplicativo, faça login com sua conta Google e insira o Token de Acesso acima para vincular seu perfil."
  ].join("\n");
  const html = `
      <p>Olá <b>${pendingUser.name ?? ''}</b>,</p>
      <p>Seu cadastro no <b>Clube de Leitura D'Elas</b> foi aprovado com sucesso! 🎉</p>
      <p><b>Seu Token de Acesso:</b> <span style="font-size:18px;font-weight:bold;color:#E6256D;">${claimToken}</span></p>
      <p>Abra o aplicativo, faça login com sua conta Google e insira o Token de Acesso acima para vincular o seu perfil.</p>
    `;
  const { error: sendError } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [
      pendingUser.email
    ],
    subject,
    text,
    html
  });
  if (sendError) {
    console.error("resend send error", sendError);
    return new Response(JSON.stringify({
      error: sendError.message ?? String(sendError)
    }), {
      status: 500,
      headers: {
        "content-type": "application/json"
      }
    });
  }
  return new Response(JSON.stringify({
    ok: true,
    claim_token: claimToken
  }), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}));
