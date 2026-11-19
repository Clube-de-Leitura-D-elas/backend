import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireRole } from "../_shared/role.ts";
import { isUuid } from "../_shared/uuid.ts";

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

  const { city_id: cityId, is_active: isActive } = body as Record<
    string,
    unknown
  >;

  if (!isUuid(cityId)) {
    return Response.json({ error: 'missing/invalid "city_id"' }, {
      status: 400,
    });
  }
  if (typeof isActive !== "boolean") {
    return Response.json({ error: 'missing/invalid "is_active"' }, {
      status: 400,
    });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const { error } = await ctx.supabaseAdmin.rpc("set_city_active", {
    p_city_id: cityId,
    p_is_active: isActive,
  });

  if (error?.code === "CZ001") {
    return Response.json({ error: "city not found" }, { status: 404 });
  }
  if (error?.code === "CZ006") {
    return Response.json(
      {
        error: "city has active groups",
        code: "city_has_active_groups",
        activeGroups: Number(error.details) || 0,
      },
      { status: 409 },
    );
  }
  if (error) {
    console.error("update-city-status-web update", oneLine(error.message));
    return Response.json({ error: "Unable to update city" }, { status: 500 });
  }

  return Response.json({ is_active: isActive });
}));
