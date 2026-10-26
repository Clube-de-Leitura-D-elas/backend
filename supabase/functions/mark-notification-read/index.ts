import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "mark-notification-read";

// `notification_id` é o `id` devolvido pela get-my-notifications: a linha da
// usuária em notifications_targets. Só ela é marcada, as outras destinatárias
// da mesma notificação não mudam.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { notification_id?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const notificationId = body?.notification_id;
  if (!isUuid(notificationId)) {
    return Response.json({ error: 'missing/invalid "notification_id"' }, {
      status: 400,
    });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(`${LOG_LABEL} profile error`, oneLine(profileError.message));
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: target, error: targetError } = await ctx.supabaseAdmin
    .from("notifications_targets")
    .select("id, read_at")
    .eq("id", notificationId)
    .eq("user_id", profile.id)
    .maybeSingle();

  if (targetError) {
    console.error(`${LOG_LABEL} target error`, oneLine(targetError.message));
    return Response.json({ error: targetError.message }, { status: 500 });
  }

  if (!target) {
    return Response.json({ error: "notification not found" }, { status: 404 });
  }

  // Já lida: mantém a data da primeira leitura.
  if (target.read_at) {
    return Response.json({
      id: target.id,
      is_read: true,
      read_at: target.read_at,
    });
  }

  const { data: updated, error: updateError } = await ctx.supabaseAdmin
    .from("notifications_targets")
    .update({ read_at: new Date().toISOString() })
    .eq("id", target.id)
    .select("id, read_at")
    .single();

  if (updateError) {
    console.error(`${LOG_LABEL} update error`, oneLine(updateError.message));
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  return Response.json({
    id: updated.id,
    is_read: true,
    read_at: updated.read_at,
  });
}));
