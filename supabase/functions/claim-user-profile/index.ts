import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { claim_token?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claimToken = typeof body?.claim_token === "string"
    ? body.claim_token.trim()
    : "";
  if (!claimToken) {
    return Response.json(
      { error: "Token inválido ou já utilizado" },
      { status: 400 },
    );
  }

  const nowIso = new Date().toISOString();

  // Consome o token de forma atômica no banco, exigindo que esteja aprovado,
  // ainda não usado e dentro do prazo de validade (`claim_token_expires_at`).
  const { data: pendingUser, error: pendingError } = await ctx.supabaseAdmin
    .from("pending_users")
    .update({ token_used_at: nowIso })
    .eq("claim_token", claimToken)
    .eq("is_approved", true)
    .is("token_used_at", null)
    .or(`claim_token_expires_at.is.null,claim_token_expires_at.gt.${nowIso}`)
    .select("*")
    .maybeSingle();

  if (pendingError) {
    console.error(
      "claim-user-profile claim token error",
      oneLine(pendingError.message),
    );
    return Response.json(
      { error: "Não foi possível concluir o cadastro" },
      { status: 500 },
    );
  }

  if (!pendingUser) {
    return Response.json(
      { error: "Token inválido ou já utilizado" },
      { status: 400 },
    );
  }

  const releaseClaimToken = async () => {
    const { error: releaseError } = await ctx.supabaseAdmin
      .from("pending_users")
      .update({ token_used_at: null })
      .eq("id", pendingUser.id);
    if (releaseError) {
      console.error(
        "claim-user-profile token rollback error",
        oneLine(releaseError.message),
      );
    }
  };

  let cityId: string | null = null;
  if (pendingUser.city) {
    let { data: cityData } = await ctx.supabaseAdmin
      .from("cities")
      .select("id")
      .ilike("name", pendingUser.city)
      .maybeSingle();
    if (!cityData) {
      const { data: newCity } = await ctx.supabaseAdmin
        .from("cities")
        .insert({ name: pendingUser.city, uf: "RS" })
        .select("id")
        .single();
      cityData = newCity;
    }
    cityId = cityData?.id ?? null;
  } else {
    const { data: fallbackCity } = await ctx.supabaseAdmin
      .from("cities")
      .select("id")
      .limit(1)
      .single();
    cityId = fallbackCity?.id ?? null;
  }

  let zoneId: string | null = null;
  if (pendingUser.zone && cityId) {
    let { data: zoneData } = await ctx.supabaseAdmin
      .from("zones")
      .select("id")
      .ilike("name", pendingUser.zone)
      .eq("city_id", cityId)
      .maybeSingle();
    if (!zoneData) {
      const { data: newZone } = await ctx.supabaseAdmin
        .from("zones")
        .insert({ name: pendingUser.zone, city_id: cityId })
        .select("id")
        .single();
      zoneData = newZone;
    }
    zoneId = zoneData?.id ?? null;
  }

  let educationLevel:
    | "ELEMENTARY"
    | "HIGH_SCHOOL"
    | "TECHNICAL"
    | "UNDERGRADUATE"
    | "POSTGRADUATE" = "HIGH_SCHOOL";
  const eduStr = pendingUser.level_of_education?.toLowerCase() || "";
  if (eduStr.includes("superior")) educationLevel = "UNDERGRADUATE";
  else if (eduStr.includes("fundamental")) educationLevel = "ELEMENTARY";
  else if (eduStr.includes("médio")) educationLevel = "HIGH_SCHOOL";
  else if (eduStr.includes("pós") || eduStr.includes("pos")) {
    educationLevel = "POSTGRADUATE";
  } else if (eduStr.includes("técnico")) educationLevel = "TECHNICAL";

  const newUserId = crypto.randomUUID();
  const { error: insertError } = await ctx.supabaseAdmin.from("users").insert([
    {
      id: newUserId,
      name: pendingUser.name,
      email: pendingUser.email,
      phone: pendingUser.phone_number,
      birth_date: pendingUser.birthday,
      job: pendingUser.job,
      level_of_education: educationLevel,
      instagram: pendingUser.instagram_user || "",
      city_id: cityId!,
      zone_id: zoneId,
      is_active: true,
      user_id: authUserId,
    },
  ]);

  if (insertError) {
    console.error(
      "claim-user-profile user insert error",
      oneLine(insertError.message),
    );
    await releaseClaimToken();
    return Response.json(
      { error: "Não foi possível concluir o cadastro" },
      { status: 500 },
    );
  }

  if (pendingUser.book_name) {
    const { error: suggestionError } = await ctx.supabaseAdmin
      .from("onboarding_book_suggestions")
      .insert([
        {
          name: pendingUser.book_name,
          user_id: newUserId,
        },
      ]);

    if (suggestionError) {
      console.error(
        "claim-user-profile book suggestion insert error",
        oneLine(suggestionError.message),
      );
      const { error: rollbackError } = await ctx.supabaseAdmin
        .from("users")
        .delete()
        .eq("id", newUserId);
      if (rollbackError) {
        console.error(
          "claim-user-profile user rollback error",
          oneLine(rollbackError.message),
        );
      }
      await releaseClaimToken();
      return Response.json(
        { error: "Não foi possível concluir o cadastro" },
        { status: 500 },
      );
    }
  }

  return Response.json({ success: true });
}));
