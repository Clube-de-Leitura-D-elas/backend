import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";

const LOG_LABEL = "get-my-notifications";

type TargetRow = {
  id: string;
  read_at: string | null;
  meeting_id: string | null;
  group_id: string | null;
  notifications: {
    title: string;
    message: string;
    type: string;
    scheduled_for: string;
  };
};

// Notificações da usuária autenticada, mais recentes primeiro. Uma notificação
// agendada só aparece quando `scheduled_for` chega.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
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
    console.error(`${LOG_LABEL} profile error`, oneLine(profileError.message));
    return serverError();
  }

  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { from, to } = parseListParams(new URL(req.url));
  // Mesmo instante nas duas consultas: o badge conta o que a lista mostra.
  const now = new Date().toISOString();

  const [page, unread] = await Promise.all([
    ctx.supabaseAdmin
      .from("notifications_targets")
      .select(
        "id, read_at, meeting_id, group_id, notifications!inner(title, message, type, scheduled_for)",
        { count: "exact" },
      )
      .eq("user_id", profile.id)
      .lte("notifications.scheduled_for", now)
      .order("notifications(scheduled_for)", { ascending: false })
      .order("id")
      .range(from, to),
    ctx.supabaseAdmin
      .from("notifications_targets")
      .select("id, notifications!inner(scheduled_for)", {
        count: "exact",
        head: true,
      })
      .eq("user_id", profile.id)
      .is("read_at", null)
      .lte("notifications.scheduled_for", now),
  ]);

  if (page.error) {
    console.error(`${LOG_LABEL} error`, oneLine(page.error.message));
    return serverError();
  }

  if (unread.error) {
    console.error(`${LOG_LABEL} unread error`, oneLine(unread.error.message));
    return serverError();
  }

  const notifications = ((page.data ?? []) as unknown as TargetRow[])
    .map((target) => ({
      id: target.id,
      title: target.notifications.title,
      message: target.notifications.message,
      type: target.notifications.type,
      date: target.notifications.scheduled_for,
      is_read: target.read_at !== null,
      read_at: target.read_at,
      meeting_id: target.meeting_id,
      group_id: target.group_id,
    }));

  return Response.json({
    notifications,
    total: page.count ?? 0,
    unread_count: unread.count ?? 0,
  });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to load notifications" }, {
    status: 500,
  });
}
