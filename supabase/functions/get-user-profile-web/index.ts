import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

type ProfileRow = { name: string | null; photos: { url: string } | null };

// Nome e foto da usuária autenticada, para o cabeçalho do painel web.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("users")
    .select("name, photos(url)")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("get-user-profile-web error", oneLine(error.message));
    return Response.json({ error: "Unable to load profile" }, { status: 500 });
  }

  const profile = data as unknown as ProfileRow | null;
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const photoPath = profile.photos?.url ?? null;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(ctx, req, [photoPath]);
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    success: true,
    profile: {
      name: profile.name,
      photoUrl: resolvePhotoUrl(photoPath),
    },
  });
}));
