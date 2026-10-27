import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { isUuid } from "../_shared/uuid.ts";

type UpdateParticipanteBody = {
    participant_id: string;
    name: string;
    email: string;
    phone: string;
    instagram: string | null;
    city_id: string;
    zone_id: string | null;
    birth_date: string;
    job: string | null;
    app_role: "MANAGER" | "READER" | "FOUNDER";
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

    const participantId = payload.participant_id;

    if (!isUuid(participantId)) {
        return Response.json(
            { error: 'missing/invalid "participant_id"' },
            { status: 400 },
        );
    }

    const name = payload.name;
    const email = payload.email;
    const phone = payload.phone;
    const cityId = payload.city_id;
    const birthDate = payload.birth_date;

    if (typeof name !== "string" || !name.trim()) {
        return Response.json(
            { error: 'missing/invalid "name"' },
            { status: 400 },
        );
    }

    if (typeof email !== "string" || !email.trim()) {
        return Response.json(
            { error: 'missing/invalid "email"' },
            { status: 400 },
        );
    }

    if (typeof phone !== "string" || !phone.trim()) {
        return Response.json(
            { error: 'missing/invalid "phone"' },
            { status: 400 },
        );
    }

    if (typeof cityId !== "string" || !cityId.trim() || !isUuid(cityId)) {
        return Response.json(
            { error: 'missing/invalid "city"' },
            { status: 400 },
        );
    }

    if (typeof birthDate !== "string" || !birthDate.trim()) {
        return Response.json(
            {
                error: 'missing/invalid "birth_date": expected a non-empty string',
            },
            { status: 400 },
        );
    }

    const appRole = payload.app_role;

    if (appRole !== "MANAGER" && appRole !== "READER" && appRole !== "FOUNDER") {
        return Response.json(
            { error: 'invalid "app_role": expected MANAGER, READER or FOUNDER' },
            { status: 400 },
        );
    }

    const instagram = payload.instagram;
    const zoneId = payload.zone_id;
    const job = payload.job;

    if (!isNullableString(instagram)) {
        return Response.json(
            { error: 'invalid "instagram"' },
            { status: 400 },
        );
    }

    if (zoneId !== null && !isUuid(zoneId)) {
        return Response.json(
            { error: 'invalid "zone_id"' },
            { status: 400 },
        );
    }

    if (!isNullableString(job)) {
        return Response.json(
            { error: 'invalid "job"' },
            { status: 400 },
        );
    }

    const updates = {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        instagram,
        city_id: cityId,
        zone_id: zoneId,
        birth_date: birthDate,
        job,
        app_role: appRole,
    };


    const {
        data: currentParticipant,
        error: currentParticipantError,
    } = await ctx.supabaseAdmin
        .from("users")
        .select("id, user_id, email")
        .eq("id", participantId)
        .maybeSingle();

    if (currentParticipantError) {
        console.error(
            "get-participant-before-update error",
            currentParticipantError,
        );

        return Response.json(
            { error: "could not retrieve participant" },
            { status: 500 },
        );
    }

    if (!currentParticipant) {
        return Response.json(
            { error: "participant not found" },
            { status: 404 },
        );
    }

    if (!isUuid(currentParticipant.user_id)) {
        console.error(
            "Invalid participant user_id:",
            currentParticipant.user_id,
        );

        return Response.json(
            { error: "participant has an invalid authentication user_id" },
            { status: 400 },
        );
    }

    const { error: authError } =
        await ctx.supabaseAdmin.auth.admin.updateUserById(
            currentParticipant.user_id,
            {
                email: email.trim(),
                email_confirm: true,
            },
        );

    if (authError) {
        console.error("update-participant-auth error", authError);

        return Response.json(
            { error: "could not update authentication email" },
            { status: 500 },
        );
    }


    const { data, error } = await ctx.supabaseAdmin
        .from("users")
        .update(updates)
        .eq("id", participantId)
        .select("id, name, email, phone, instagram, city_id, zone_id, birth_date, job, app_role")
        .maybeSingle();

    if (error || !data) {
        if (error) {
            console.error("update-participant error", error);
        }

        if (!error && !data) {
            console.error(
                "update-participant: no participant returned after update",
            );
        }

        const { error: rollbackError } =
            await ctx.supabaseAdmin.auth.admin.updateUserById(
                currentParticipant.user_id,
                {
                    email: currentParticipant.email,
                    email_confirm: true,
                },
            );

        if (rollbackError) {
            console.error(
                "update-participant-auth rollback error",
                rollbackError,
            );

            return Response.json(
                {
                    error: "database update failed and authentication email rollback failed",
                },
                { status: 500 },
            );
        }

        if (!data && !error) {
            return Response.json(
                { error: "participant not found" },
                { status: 404 },
            );
        }

        return Response.json(
            { error: "could not update participant; authentication email was restored" },
            { status: 500 },
        );
    }

    return Response.json(data);
}));