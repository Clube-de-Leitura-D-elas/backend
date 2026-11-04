import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";
import { oneLine } from "../_shared/log.ts";

// `promote` adiciona a coordenação, `demote` tira só o papel (o vínculo segue
// ACTIVE) e `remove` inativa a participação inteira.
const CHANGES_BY_ACTION = {
  promote: { is_coordinator: true },
  demote: { is_coordinator: false },
  remove: { registration_status: "INACTIVE" as const, is_coordinator: false },
};

type Action = keyof typeof CHANGES_BY_ACTION;

function isAction(value: unknown): value is Action {
  return typeof value === "string" && Object.hasOwn(CHANGES_BY_ACTION, value);
}

// POST { groupId, participantId, action: "promote" | "demote" | "remove" }
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
  if (!isUuid(groupId) || !isUuid(participantId) || !isAction(action)) {
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
  if (action === "demote" && !membership.is_coordinator) {
    return Response.json({ error: "participant is not a coordinator" }, { status: 409 });
  }

  // O grupo não pode perder a última coordenadora, nem rebaixada nem removida.
  const losesCoordinator = membership.is_coordinator && action !== "promote";
  if (losesCoordinator) {
    const { count, error: countError } = await countActiveCoordinators(ctx, groupId);
    if (countError) {
      console.error("update-group-participant count", oneLine(countError.message));
      return Response.json({ error: "unable to update membership" }, { status: 500 });
    }
    if ((count ?? 0) <= 1) return lastCoordinatorResponse();
  }

  const { data: updated, error } = await ctx.supabaseAdmin
    .from("group_users")
    .update(CHANGES_BY_ACTION[action])
    .eq("id", membership.id)
    .eq("registration_status", "ACTIVE")
    .select("id, is_coordinator, registration_status")
    .maybeSingle();

  if (error) {
    console.error("update-group-participant update", oneLine(error.message));
    return Response.json({ error: "unable to update membership" }, { status: 500 });
  }
  if (!updated) return Response.json({ error: "membership changed; refresh and retry" }, { status: 409 });

  // Sem transação: duas coordenadoras saindo ao mesmo tempo passam juntas pela
  // checagem acima. Se o grupo zerou, desfaz esta alteração.
  if (losesCoordinator) {
    const { count, error: recountError } = await countActiveCoordinators(ctx, groupId);
    if (recountError || (count ?? 0) === 0) {
      const { error: revertError } = await ctx.supabaseAdmin
        .from("group_users")
        .update({ is_coordinator: true, registration_status: "ACTIVE" })
        .eq("id", membership.id);
      if (revertError) {
        console.error("update-group-participant revert", oneLine(revertError.message));
        return Response.json({ error: "unable to update membership" }, { status: 500 });
      }
      if (recountError) {
        console.error("update-group-participant recount", oneLine(recountError.message));
        return Response.json({ error: "unable to update membership" }, { status: 500 });
      }
      return lastCoordinatorResponse();
    }
  }

  return Response.json({ success: true, is_coordinator: updated.is_coordinator, registration_status: updated.registration_status });
}));

function countActiveCoordinators(ctx: SupabaseContext<Database>, groupId: string) {
  return ctx.supabaseAdmin
    .from("group_users")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("is_coordinator", true)
    .eq("registration_status", "ACTIVE");
}

function lastCoordinatorResponse() {
  return Response.json({ error: "group must keep at least one coordinator" }, { status: 409 });
}
