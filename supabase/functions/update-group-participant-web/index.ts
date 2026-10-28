import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";
import { oneLine } from "../_shared/log.ts";

// POST { groupId, participantId, action: "promote" | "remove" }
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") return Response.json({ error: "expected POST" }, { status: 405 });
  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    const input: unknown = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid payload");
    body = input as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { groupId, participantId, action } = body;
  if (!isUuid(groupId) || !isUuid(participantId) || (action !== "promote" && action !== "remove")) {
    return Response.json({ error: "invalid groupId, participantId or action" }, { status: 400 });
  }

  const { data: membership, error: lookupError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id, registration_status, is_coordinator")
    .eq("group_id", groupId)
    .eq("user_id", participantId)
    .maybeSingle();

  if (lookupError) {
    console.error("update-group-participant lookup", oneLine(lookupError.message));
    return Response.json({ error: "unable to load membership" }, { status: 500 });
  }
  if (!membership || membership.registration_status !== "ACTIVE") {
    return Response.json({ error: "active membership not found" }, { status: 404 });
  }

  const changes = action === "remove"
    ? { registration_status: "INACTIVE" as const, is_coordinator: false }
    : { is_coordinator: true };

  const { data: updated, error } = await ctx.supabaseAdmin
    .from("group_users")
    .update(changes)
    .eq("id", membership.id)
    .eq("registration_status", "ACTIVE")
    .select("id, is_coordinator, registration_status")
    .maybeSingle();

  if (error) {
    console.error("update-group-participant update", oneLine(error.message));
    return Response.json({ error: "unable to update membership" }, { status: 500 });
  }
  if (!updated) return Response.json({ error: "membership changed; refresh and retry" }, { status: 409 });
  return Response.json({ success: true, is_coordinator: updated.is_coordinator, registration_status: updated.registration_status });
}));
