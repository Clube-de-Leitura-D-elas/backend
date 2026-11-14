import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

const LOG_LABEL = "register-device";
const PLATFORMS = ["ANDROID", "IOS"];
// O FCM não documenta um tamanho máximo para o token; o limite só impede que
// um corpo absurdo vire linha na tabela.
const MAX_TOKEN_LENGTH = 4096;

type DeviceRequest = { fcm_token: string; platform: string };

// Registra o aparelho da leitora autenticada para receber push. O token
// identifica o aparelho, não a conta: se ele já existia em outra conta, a
// mesma linha passa para a atual, e o aparelho deixa de receber os avisos da
// conta anterior.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const request = await readDeviceRequest(req);
  if (!request) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(`${LOG_LABEL} profile error`, oneLine(profileError.message));
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  // O upsert por fcm_token atualiza user_id, platform e updated_at na linha
  // existente e mantém o id, então o app recebe sempre o mesmo id do aparelho.
  const { data: device, error: upsertError } = await ctx.supabaseAdmin
    .from("user_devices")
    .upsert(
      {
        user_id: profile.id,
        fcm_token: request.fcm_token,
        platform: request.platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "fcm_token" },
    )
    .select("id")
    .single();

  if (upsertError) {
    console.error(`${LOG_LABEL} upsert error`, oneLine(upsertError.message));
    return serverError();
  }

  return Response.json({ id: device.id });
}));

async function readDeviceRequest(req: Request): Promise<DeviceRequest | null> {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return null;
  }

  const token = body?.fcm_token;
  const platform = body?.platform;
  if (
    typeof token !== "string" || token.trim().length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }
  if (typeof platform !== "string" || !PLATFORMS.includes(platform)) {
    return null;
  }

  return { fcm_token: token, platform };
}

function serverError(): Response {
  return Response.json({ error: "Unable to register device" }, { status: 500 });
}
