import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

const LOG_LABEL = "unregister-device";
const MAX_TOKEN_LENGTH = 4096;

// Remove o aparelho da leitora autenticada (logout no app). Só apaga a linha
// cujo token pertence a ela: se o token estiver em outra conta, nada é
// apagado. Token inexistente também responde 204, porque o resultado que o
// app quer (aquele token não receber push desta conta) já vale.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const fcmToken = await readFcmToken(req);
  if (!fcmToken) {
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

  // O filtro por user_id no próprio DELETE é o que impede apagar o token de
  // outra conta.
  const { error: deleteError } = await ctx.supabaseAdmin
    .from("user_devices")
    .delete()
    .eq("fcm_token", fcmToken)
    .eq("user_id", profile.id);

  if (deleteError) {
    console.error(`${LOG_LABEL} delete error`, oneLine(deleteError.message));
    return serverError();
  }

  return new Response(null, { status: 204 });
}));

async function readFcmToken(req: Request): Promise<string | null> {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return null;
  }

  const token = body?.fcm_token;
  if (
    typeof token !== "string" || token.trim().length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }

  return token;
}

function serverError(): Response {
  return Response.json({ error: "Unable to unregister device" }, {
    status: 500,
  });
}
