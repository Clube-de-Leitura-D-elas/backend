import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

const PROFILE_COLUMNS =
  "id, user_id, name, email, phone, birth_date, instagram, job, level_of_education, is_active, created_at, city_id, zone_id, expectations, has_other_reading_group, wants_to_coordinate, photos(url), cities(id, name), zones(id, name), onboarding_book_suggestions(name)";

type ProfileRow = {
  photos: { url: string } | null;
  cities: { id: string; name: string } | null;
  zones: { id: string; name: string } | null;
  onboarding_book_suggestions: { name: string } | { name: string }[] | null;
};

// Perfil (tabela users) da usuária autenticada.
// O withSupabase responde o preflight OPTIONS com os headers de CORS e valida o JWT.
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
    .select(PROFILE_COLUMNS)
    .eq("user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("get-user-profile error", oneLine(error.message));
    return Response.json({ error: "Unable to load profile" }, { status: 500 });
  }

  // profile null não é erro: é como o app sabe que precisa mandar para o claim.
  if (!data) {
    return Response.json({ success: true, profile: null });
  }

  const { photos, cities, zones, onboarding_book_suggestions, ...profile } =
    data as unknown as ProfileRow;
  const photoPath = photos?.url ?? null;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(ctx, req, [photoPath]);
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    success: true,
    profile: {
      ...profile,
      city: cities ? { id: cities.id, name: cities.name } : null,
      zone: zones ? { id: zones.id, name: zones.name } : null,
      book_name: Array.isArray(onboarding_book_suggestions)
        ? onboarding_book_suggestions[0]?.name ?? null
        : onboarding_book_suggestions?.name ?? null,
      photo_url: resolvePhotoUrl(photoPath),
    },
  });
}));
