import { withSupabase } from "jsr:@supabase/server@^1";
const APPROVAL_TOKEN_SECRET = Deno.env.get("APPROVAL_TOKEN_SECRET");
if (!APPROVAL_TOKEN_SECRET) {
  throw new Error("APPROVAL_TOKEN_SECRET is required");
}
function fromBase64Url(b64url) {
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const full = b64 + pad;
  const bin = atob(full);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++)bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function computeSignature(pendingUserId) {
  const keyData = new TextEncoder().encode(APPROVAL_TOKEN_SECRET);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(pendingUserId));
  return new Uint8Array(sig);
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let ok = 0;
  for(let i = 0; i < a.length; i++)ok |= a[i] ^ b[i];
  return ok === 0;
}
export default {
  fetch: withSupabase({
    auth: "none"
  }, async (req, ctx)=>{
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response("expected GET or POST request", {
        status: 405
      });
    }
    const url = new URL(req.url);
    const q = Object.fromEntries(url.searchParams.entries());
    const pending_user_id = q.pending_user_id;
    const token = q.token;
    if (!pending_user_id || typeof pending_user_id !== "string") {
      return new Response('missing/invalid "pending_user_id"', {
        status: 400
      });
    }
    if (!token || typeof token !== "string") {
      return new Response('missing/invalid "token"', {
        status: 400
      });
    }
    const expectedSig = await computeSignature(pending_user_id);
    const providedSig = fromBase64Url(token);
    if (!bytesEqual(expectedSig, providedSig)) {
      return new Response("invalid/expired token", {
        status: 401
      });
    }
    // Idempotent approve: set is_approved = true.
    // This UPDATE triggers the PostgreSQL trigger `pending_user_approval_notify`,
    // which calls `approve-pending-user` to send the single email to the user.
    const { data: updated, error } = await ctx.supabaseAdmin.from("pending_users").update({
      is_approved: true
    }).eq("id", pending_user_id).eq("is_approved", false).select("id, is_approved");
    if (error) {
      console.error("pending_user approve update error", error);
      return new Response(JSON.stringify({
        error: error.message
      }), {
        status: 500,
        headers: {
          "content-type": "application/json"
        }
      });
    }
    const alreadyApproved = (updated?.length ?? 0) === 0;
    const htmlResponse = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Cadastro Aprovado</title>
          <style>
            body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #faf8f9; }
            .card { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); text-align: center; max-width: 400px; }
            h1 { color: #e6256d; font-size: 24px; margin-bottom: 8px; }
            p { color: #7c7379; font-size: 16px; margin-bottom: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>${alreadyApproved ? 'Usuária já Aprovada! ℹ️' : 'Usuária Aprovada com Sucesso! ✅'}</h1>
            <p>${alreadyApproved ? 'Este cadastro já havia sido aprovado anteriormente.' : 'O Token de Acesso foi enviado por e-mail para a usuária.'}</p>
          </div>
        </body>
      </html>
    `;
    return new Response(htmlResponse, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    });
  })
};
