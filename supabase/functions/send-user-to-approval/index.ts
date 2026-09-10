import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { Resend } from "npm:resend@4.0.0";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is required");
const FROM_EMAIL = Deno.env.get("EMAIL_FROM");
if (!FROM_EMAIL) throw new Error("EMAIL_FROM is required");
const APPROVAL_FIXED_EMAIL = Deno.env.get("APPROVAL_FIXED_EMAIL");
if (!APPROVAL_FIXED_EMAIL) throw new Error("APPROVAL_FIXED_EMAIL is required");
const APPROVAL_TOKEN_SECRET = Deno.env.get("APPROVAL_TOKEN_SECRET");
if (!APPROVAL_TOKEN_SECRET) throw new Error("APPROVAL_TOKEN_SECRET is required");
const EDGE_BASE_URL = Deno.env.get("EDGE_BASE_URL") ?? null;
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
  auth: "secret"
}, async (req)=>{
  if (req.method !== "POST") {
    return new Response("expected POST request", {
      status: 405
    });
  }
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return new Response("expected application/json", {
      status: 400
    });
  }
  const body = await req.json();
  const id = body.id;
  const email = body.email;
  if (!id || typeof id !== "string") {
    return new Response('missing/invalid "id"', {
      status: 400
    });
  }
  if (!email || typeof email !== "string") {
    return new Response('missing/invalid "email"', {
      status: 400
    });
  }
  const token = await signToken(id);
  const origin = EDGE_BASE_URL ?? new URL(req.url).origin;
  // IMPORTANT: button calls your new approve-user function
  const approveUrl = `${origin}/functions/v1/approve-user?pending_user_id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  const subject = "Approve pending user";
  const text = [
    "A pending user needs approval.",
    "",
    `Pending user UUID: ${id}`,
    `Pending user email: ${email}`,
    "",
    `Approve by clicking: ${approveUrl}`
  ].join("\n");
  const html = `
        <p>A pending user needs approval.</p>
        <p><b>Pending user UUID:</b> ${id}</p>
        <p><b>Pending user email:</b> ${email}</p>
        <p>
          <a href="${approveUrl}" target="_blank" rel="noreferrer"
             style="display:inline-block;padding:10px 16px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">
            Approve user
          </a>
        </p>
      `;
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [
      APPROVAL_FIXED_EMAIL
    ],
    subject,
    text,
    html
  });
  if (error) {
    console.error("resend send error", error);
    return new Response(JSON.stringify({
      error: error.message ?? String(error)
    }), {
      status: 500,
      headers: {
        "content-type": "application/json"
      }
    });
  }
  return new Response(JSON.stringify({
    ok: true
  }), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}));
