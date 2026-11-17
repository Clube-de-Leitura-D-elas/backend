import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const {
    current_password: currentPassword,
    new_password: newPassword,
  } = body as Record<string, unknown>;

  if (typeof currentPassword !== "string" || !currentPassword) {
    return Response.json({ error: 'missing/invalid "current_password"' }, {
      status: 400,
    });
  }
  if (
    typeof newPassword !== "string" ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    return Response.json({ error: 'missing/invalid "new_password"' }, {
      status: 400,
    });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: "new password is too short", code: "weak_password" },
      { status: 422 },
    );
  }
  if (newPassword === currentPassword) {
    return Response.json(
      { error: "new password equals the current one", code: "same_password" },
      { status: 422 },
    );
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const authUserId = ctx.userClaims!.id;

  const { data: check, error: checkError } = await ctx.supabaseAdmin.rpc(
    "check_user_password",
    { p_user_id: authUserId, p_password: currentPassword },
  );

  if (checkError) {
    console.error("change-password-web check", oneLine(checkError.message));
    return Response.json({ error: "Unable to change password" }, {
      status: 500,
    });
  }
  if (check === "locked") {
    return Response.json(
      { error: "too many attempts", code: "too_many_attempts" },
      { status: 429 },
    );
  }
  if (check !== "ok") {
    return Response.json(
      { error: "current password is wrong", code: "wrong_password" },
      { status: 403 },
    );
  }

  const { error: updateError } = await ctx.supabaseAdmin.auth.admin
    .updateUserById(authUserId, { password: newPassword });

  if (updateError?.code === "weak_password") {
    return Response.json(
      { error: "new password is too weak", code: "weak_password" },
      { status: 422 },
    );
  }
  if (updateError) {
    console.error("change-password-web update", oneLine(updateError.message));
    return Response.json({ error: "Unable to change password" }, {
      status: 500,
    });
  }

  return Response.json({ changed: true });
}));
