import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5.9.6";

// Obtém token de acesso OAuth2 para o FCM HTTP v1 usando a Service Account
async function getFirebaseAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const normalizedKey = privateKeyPem.includes("\\n")
    ? privateKeyPem.replace(/\\n/g, "\n")
    : privateKeyPem;

  const privateKey = await importPKCS8(normalizedKey, "RS256");
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch Firebase OAuth token: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  return data.access_token;
}

interface SendPushRequest {
  user_ids?: string[];
  title?: string;
  body?: string;
  data?: Record<string, string>;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Expected POST request" }, { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const projectId = Deno.env.get("FIREBASE_PROJECT_ID");
  const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL");
  const privateKey = Deno.env.get("FIREBASE_PRIVATE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    return Response.json({ error: "Supabase environment variables missing" }, { status: 500 });
  }

  if (!projectId || !clientEmail || !privateKey) {
    return Response.json({ error: "Firebase secrets missing in environment" }, { status: 500 });
  }

  let payload: SendPushRequest;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { user_ids, title, body, data: customData } = payload;

  if (!Array.isArray(user_ids) || user_ids.length === 0) {
    return Response.json(
      { error: 'Missing or invalid "user_ids": must be a non-empty array of UUIDs' },
      { status: 400 },
    );
  }

  if (typeof title !== "string" || title.trim().length === 0) {
    return Response.json(
      { error: 'Missing or invalid "title": must be a non-empty string' },
      { status: 400 },
    );
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    return Response.json(
      { error: 'Missing or invalid "body": must be a non-empty string' },
      { status: 400 },
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Busca os usuários no banco onde o id ou o user_id (auth) esteja na lista
  // e que possuam um fcm_token cadastrado
  const cleanUserIds = user_ids.map((id) => String(id).trim());

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("id, user_id, name, fcm_token")
    .or(`id.in.(${cleanUserIds.join(",")}),user_id.in.(${cleanUserIds.join(",")})`);

  if (usersError) {
    console.error("Error querying users for push notifications:", usersError);
    return Response.json({ error: usersError.message }, { status: 500 });
  }

  const usersWithToken = (users || []).filter((u) => u.fcm_token && u.fcm_token.trim().length > 0);

  if (usersWithToken.length === 0) {
    return Response.json({
      success: true,
      total_requested: cleanUserIds.length,
      users_found: (users || []).length,
      tokens_found: 0,
      notifications_sent: 0,
      message: "Nenhum dos usuários solicitados possui token FCM cadastrado.",
    });
  }

  let accessToken: string;
  try {
    accessToken = await getFirebaseAccessToken(clientEmail, privateKey);
  } catch (err) {
    console.error("Failed to authenticate with Firebase:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  // 1. Grava no histórico de notificações do app
  const now = new Date();
  const { data: createdNotif } = await supabase
    .from("notifications")
    .insert({
      title: title.trim(),
      message: body.trim(),
      type: "COORDINATOR_TASKS_REMINDER",
      scheduled_for: now.toISOString(),
    })
    .select("id")
    .single();

  const notifId = createdNotif?.id;

  let sentCount = 0;
  let invalidCount = 0;
  const dispatchDetails: Array<{
    user_id: string;
    profile_id: string;
    status: "sent" | "failed" | "unregistered";
    error?: string;
  }> = [];

  // Converte data payload garantindo que todos os valores sejam strings
  const stringifiedData: Record<string, string> = {};
  if (customData && typeof customData === "object") {
    for (const [k, v] of Object.entries(customData)) {
      stringifiedData[k] = String(v);
    }
  }

  for (const user of usersWithToken) {
    // Registra alvo in-app
    if (notifId) {
      await supabase.from("notifications_targets").insert({
        notification_id: notifId,
        user_id: user.id,
      });
    }

    try {
      const fcmResponse = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: user.fcm_token,
              notification: {
                title: title.trim(),
                body: body.trim(),
              },
              data: {
                ...stringifiedData,
                notification_id: notifId ? String(notifId) : "",
              },
              android: {
                priority: "high",
                notification: {
                  sound: "default",
                },
              },
              apns: {
                payload: {
                  aps: {
                    sound: "default",
                    badge: 1,
                  },
                },
              },
            },
          }),
        }
      );

      if (fcmResponse.ok) {
        sentCount++;
        dispatchDetails.push({
          user_id: user.user_id,
          profile_id: user.id,
          status: "sent",
        });
      } else {
        const errJson = await fcmResponse.json();
        console.warn(`FCM send error for user ${user.id}:`, errJson);
        const errorCode = errJson?.error?.details?.[0]?.errorCode || errJson?.error?.status;

        if (
          errorCode === "UNREGISTERED" ||
          errorCode === "INVALID_ARGUMENT" ||
          errJson?.error?.message?.includes("not a valid FCM registration token")
        ) {
          invalidCount++;
          // Limpa token inválido no banco
          await supabase.from("users").update({ fcm_token: null }).eq("id", user.id);
          dispatchDetails.push({
            user_id: user.user_id,
            profile_id: user.id,
            status: "unregistered",
            error: "Token expirado ou inválido (removido)",
          });
        } else {
          dispatchDetails.push({
            user_id: user.user_id,
            profile_id: user.id,
            status: "failed",
            error: errJson?.error?.message || "Unknown FCM error",
          });
        }
      }
    } catch (err) {
      console.error(`Unexpected error sending push to user ${user.id}:`, err);
      dispatchDetails.push({
        user_id: user.user_id,
        profile_id: user.id,
        status: "failed",
        error: String(err),
      });
    }
  }

  return Response.json({
    success: true,
    total_requested: cleanUserIds.length,
    users_found: (users || []).length,
    tokens_found: usersWithToken.length,
    notifications_sent: sentCount,
    tokens_invalid: invalidCount,
    details: dispatchDetails,
  });
});
