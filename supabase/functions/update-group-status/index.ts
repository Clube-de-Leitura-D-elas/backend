import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
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

    const { data, error } = await ctx.supabaseAdmin
      .from("groups")
      .update({ active: isActive })
      .eq("id", groupId)
      .select("active")
      .maybeSingle();

    if (error) {
      console.error("update-group-status error", error);
      return Response.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return Response.json({ error: "group not found" }, { status: 404 });
    }
    return Response.json({ isActive: data.active });
  }),
);
