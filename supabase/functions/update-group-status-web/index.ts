import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";
import {
  inactiveLocationCode,
  inactiveLocationResponse,
} from "../_shared/city.ts";

// Ativa ou inativa um grupo. Body JSON: { group_id, is_active }.
Deno.serve(
  withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
    const denied = await requireFounder(ctx);
    if (denied) return denied;

    if (req.method !== "POST") {
      return Response.json({ error: "expected POST request" }, { status: 405 });
    }

    let body: { group_id?: unknown; is_active?: unknown } | null;
    try {
      body = await req.json();
    } catch (error) {
      return Response.json({ error: "expected JSON body " }, { status: 400 });
    }

    const groupId = body?.group_id;
    const isActive = body?.is_active;

    if (!isUuid(groupId)) {
      return Response.json(
        { error: 'missing/invalid "group_id"' },
        { status: 400 },
      );
    }
    if (typeof isActive !== "boolean") {
      return Response.json(
        { error: 'missing/invalid "is_active"' },
        { status: 400 },
      );
    }

    if (isActive) {
      const { data: group, error: groupError } = await ctx.supabaseAdmin
        .from("groups")
        .select("cities(is_active), zones(is_active)")
        .eq("id", groupId)
        .maybeSingle();

      if (groupError) {
        console.error(
          "update-group-status-web location",
          oneLine(groupError.message),
        );
        return Response.json({ error: "Unable to update group" }, {
          status: 500,
        });
      }

      const location = group as
        | {
          cities: { is_active: boolean } | null;
          zones: { is_active: boolean } | null;
        }
        | null;
      if (location?.cities && !location.cities.is_active) {
        return inactiveLocationResponse("city_inactive", 409);
      }
      if (location?.zones && !location.zones.is_active) {
        return inactiveLocationResponse("zone_inactive", 409);
      }
    }

    const { data, error } = await ctx.supabaseAdmin
      .from("groups")
      .update({ is_active: isActive })
      .eq("id", groupId)
      .select("is_active")
      .maybeSingle();

    if (error) {
      const inactive = inactiveLocationCode(error);
      if (inactive) return inactiveLocationResponse(inactive, 409);

      console.error("update-group-status-web update", oneLine(error.message));
      return Response.json({ error: "Unable to update group" }, {
        status: 500,
      });
    }

    if (!data) {
      return Response.json({ error: "group not found" }, { status: 404 });
    }
    return Response.json({ is_active: data.is_active });
  }),
);
