import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";

// Perfil (tabela users) da usuária autenticada.
// O withSupabase responde o preflight OPTIONS com os headers de CORS e valida o JWT.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (_req, ctx) => {
    const authUserId = ctx.userClaims?.id;
    if (!authUserId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: profile, error } = await ctx.supabaseAdmin
        .from("users")
        .select("name,photo_id")
        .eq("user_id", authUserId)
        .maybeSingle();

    if (error) {
        console.error("get-user-profile error", error);
        return Response.json({ error: error.message }, { status: 500 });
    }

    let photoUrl: string | null = null;

    if (profile?.photo_id) {
        const { data: photo, error: photoError } = await ctx.supabaseAdmin
            .from("photos")
            .select("url")
            .eq("id", profile.photo_id)
            .maybeSingle();

        if (photoError) {
            console.error("get-user-profile photo error", photoError);
            return Response.json(
                { error: photoError.message },
                { status: 500 },
            );
        }

        photoUrl = photo?.url ?? null;
    }

    return Response.json({
        success: true,
        profile: {
            name: profile?.name ?? null,
            photoUrl,
        },
    });
}));
