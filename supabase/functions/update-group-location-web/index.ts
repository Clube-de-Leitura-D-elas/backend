import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { isUuid } from "../_shared/uuid.ts";


type UpdateGroupLocationBody = {
    group_id: string;
    description: string;
    city_id: string;
    zone_id: string | null;
}

const isNullableString = (
    value: unknown,
): value is string | null => {
    return value === null || typeof value === "string";
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
    const denied = await requireFounder(ctx);
    if (denied) return denied;

    if (req.method !== "POST") {
        return Response.json(
            { error: "expected POST request" },
            { status: 405 },
        );
    }

    let body: unknown;

    try {
        body = await req.json();
    } catch {
        return Response.json(
            { error: "expected JSON body" },
            { status: 400 },
        );
    }

    if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
    ) {
        return Response.json(
            { error: "invalid JSON body" },
            { status: 400 },
        );
    }

    const payload = body as Record<string, unknown>;

    const groupId = payload.group_id;

    if (!isUuid(groupId)) {
        return Response.json(
            { error: 'missing/invalid "groupId"' },
            { status: 400 },
        );
    }

    //Campos não nulos
    const description = payload.description;
    const cityId = payload.city_id;


    if (typeof description !== "string" || !description.trim()) {
        return Response.json(
            { error: 'missing/invalid "description"' },
            { status: 400 },
        );
    }

    if (typeof cityId !== "string" || !cityId.trim() || !isUuid(cityId)) {
        return Response.json(
            { error: 'missing/invalid "cityId"' },
            { status: 400 },
        );
    }

    //Campo Nulo

    const zoneId = payload.zone_id;

    if (zoneId !== null && !isUuid(zoneId)) {
        return Response.json(
            { error: 'invalid "zone_id"' },
            { status: 400 },
        );
    }

    const updates = {
        description: description.trim(),
        city_id: cityId,
        zone_id: zoneId,
    };

    const { data, error } = await ctx.supabaseAdmin
        .from("groups")
        .update(updates)
        .eq("id", groupId)
        .select("id,description,city_Id,zone_Id")
        .maybeSingle();

    if (error || !data) {
        if (error) {
            console.error("update-group_location error", error);
        }

        if (!error && !data) {
            console.error(
                "update-group_location: no group returned after update",
            );
        }

        if (!data && !error) {
            return Response.json(
                { error: "group not found" },
                { status: 404 },
            );
        }


    }
    return Response.json(data);
}));