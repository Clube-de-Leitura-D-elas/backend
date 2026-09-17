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
<!DOCTYPE html>
<html lang="pt-BR">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Seu cadastro foi aprovado! | Clube de Leitura D'Elas</title>
  <!--[if mso]>
      <style type="text/css">
        body, table, td {font-family: Arial, Helvetica, sans-serif !important;}
      </style>
      <![endif]-->
</head>

<body
  style="margin: 0; padding: 0; background-color: #FAF8F9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">

  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
    style="background-color: #FAF8F9; padding: 40px 16px;">
    <tr>
      <td align="center">

        <!-- Main Card -->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
          style="max-width: 480px; background-color: #FFFFFF; border: 1px solid #E4E0E3; border-radius: 20px; box-shadow: 0 8px 24px rgba(27, 23, 26, 0.05); overflow: hidden;">

          <!-- Header Banner / Brand Strip -->
          <tr>
            <td align="center" style="background-color: #FCE8F0; padding: 32px 24px 24px 24px;">
              <!-- Book Icon Header Badge -->
              <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center"
                    style="width: 64px; height: 64px; background-color: #FFFFFF; border-radius: 50%; box-shadow: 0 4px 12px rgba(230, 37, 109, 0.15);">
                    <span style="font-size: 30px; line-height: 64px; display: block;">📖</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 32px 32px 40px 32px; text-align: center;">

              <h1
                style="margin: 0 0 12px 0; color: #1B171A; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3;">
                Seu cadastro foi aprovado! 🎉
              </h1>

              <p style="margin: 0 0 20px 0; color: #7C7379; font-size: 15px; line-height: 1.6;">
                Olá <strong>${pendingUser.name ?? ''}</strong>, seu cadastro no <strong>Clube de Leitura D'Elas</strong> foi aprovado com sucesso!
              </p>

              <!-- Token Display Box -->
              <div style="background-color: #FAF8F9; border: 1px dashed #E6256D; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
                <p style="margin: 0 0 6px 0; color: #7C7379; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">
                  Seu Token de Acesso
                </p>
                <span style="font-size: 24px; font-weight: 700; color: #E6256D; letter-spacing: 0.1em; display: inline-block;">
                  ${claimToken}
                </span>
              </div>

              <p style="margin: 0 0 28px 0; color: #7C7379; font-size: 14px; line-height: 1.6;">
                Abra o aplicativo, faça login na sua conta e insira o token acima para vincular o seu perfil.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"
                style="margin-bottom: 28px;">
                <tr>
                  <td align="center">
                    <a href="https://drive.usercontent.google.com/download?id=1oY2iCwCY0X6x-H-DsHzT2WnrfrND9Etd&amp;export=download&amp;authuser=0"
                      target="_blank" style="display: inline-block; width: 100%; max-width: 320px; padding: 14px 24px; background-color: #E6256D; color: #FFFFFF; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 12px; text-align: center; box-sizing: border-box; box-shadow: 0 4px 12px rgba(230, 37, 109, 0.25);">
                      Baixar Aplicativo (APK)
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0; color: #A39BA0; font-size: 13px; line-height: 1.5;">
                Se você não solicitou este cadastro, pode ignorar este e-mail com segurança.
              </p>

            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td
              style="border-top: 1px solid #F2EFF1; padding: 20px 32px; background-color: #FAF8F9; text-align: center;">
              <p style="margin: 0; color: #7C7379; font-size: 12px;">
                © 2026 <strong>Clube de Leitura D'Elas</strong>. Todos os direitos reservados.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>

</html>
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
