import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

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
        .select("cities(is_active)")
        .eq("id", groupId)
        .maybeSingle();

      if (groupError) {
        console.error(
          "update-group-status-web city",
          oneLine(groupError.message),
        );
        return Response.json({ error: "Unable to update group" }, {
          status: 500,
        });
      }

      const city = (group as { cities: { is_active: boolean } | null } | null)
        ?.cities;
      if (city && !city.is_active) {
        return Response.json(
          { error: "group city is inactive", code: "city_inactive" },
          { status: 409 },
        );
      }
    }

    const { data, error } = await ctx.supabaseAdmin
      .from("groups")
      .update({ is_active: isActive })
      .eq("id", groupId)
      .select("is_active")
      .maybeSingle();

    if (error) {
      console.error("update-group-status-web error", error);
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return Response.json({ error: "group not found" }, { status: 404 });
    }
    return Response.json({ is_active: data.is_active });
  }),
);
