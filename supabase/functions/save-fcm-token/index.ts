import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

// Salva ou atualiza o token FCM da usuária autenticada para envio de push notifications.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { fcm_token?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const fcmToken = body?.fcm_token;
  if (fcmToken !== null && (typeof fcmToken !== "string" || fcmToken.trim().length === 0)) {
    return Response.json(
      { error: 'missing/invalid "fcm_token": must be a non-empty string or null' },
      { status: 400 },
    );
  }

  const tokenValue = typeof fcmToken === "string" ? fcmToken.trim() : null;

  if (tokenValue !== null) {
    const { error: clearError } = await ctx.supabaseAdmin
      .from("users")
      .update({
        fcm_token: null,
        fcm_token_updated_at: null,
      })
      .eq("fcm_token", tokenValue)
      .neq("user_id", authUserId);

    if (clearError) {
      console.error("save-fcm-token clear duplicate", oneLine(clearError.message));
      return Response.json({ error: "Failed to save FCM token" }, { status: 500 });
    }
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("users")
    .update({
      fcm_token: tokenValue,
      fcm_token_updated_at: new Date().toISOString(),
    })
    .eq("user_id", authUserId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("save-fcm-token update", oneLine(error.message));
    return Response.json({ error: "Failed to save FCM token" }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}));
