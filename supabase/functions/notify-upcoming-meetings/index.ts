import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5.9.6";
import { todayInSaoPaulo } from "../_shared/date.ts";
import { oneLine } from "../_shared/log.ts";

// Obtém token de acesso OAuth2 usando a chave privada da Service Account do Firebase
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Expected POST request" }, { status: 405 });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = req.headers.get("Authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
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

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Janela: encontros entre 6 e 7 dias a partir de hoje em America/Sao_Paulo
  const todayStr = todayInSaoPaulo();
  const [y, m, d] = todayStr.split("-").map(Number);
  const startDay = new Date(Date.UTC(y, m - 1, d + 6)).toISOString().slice(0, 10);
  const endDay = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const windowStart = `${startDay}T00:00:00-03:00`;
  const windowEnd = `${endDay}T23:59:59.999-03:00`;

  // Busca os encontros que acontecem na janela de 6 a 7 dias e ainda não foram avisados
  const { data: meetings, error: meetingsError } = await supabase
    .from("meetings")
    .select(`
      id,
      date,
      group_id,
      status,
      groups (
        id,
        number,
        description
      ),
      books (
        id,
        name
      )
    `)
    .eq("reminder_1_week_sent", false)
    .in("status", ["CREATED", "SCHEDULED"])
    .gte("date", windowStart)
    .lte("date", windowEnd);

  if (meetingsError) {
    console.error("notify-upcoming-meetings fetch meetings", oneLine(meetingsError.message));
    return Response.json({ error: "Failed to fetch upcoming meetings" }, { status: 500 });
  }

  if (!meetings || meetings.length === 0) {
    return Response.json({
      message: "Nenhuma reunião pendente de aviso para os próximos 7 dias.",
      checked_at: now.toISOString(),
      meetings_count: 0,
    });
  }

  let accessToken: string;
  try {
    accessToken = await getFirebaseAccessToken(clientEmail, privateKey);
  } catch (err) {
    console.error("Failed to authenticate with Firebase:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  const results: Array<{
    meeting_id: string;
    notifications_sent: number;
    tokens_invalid: number;
  }> = [];

  for (const meeting of meetings) {
    // 1. Busca os membros ativos do grupo
    const { data: groupUsers, error: groupUsersError } = await supabase
      .from("group_users")
      .select(`
        user_id,
        registration_status,
        users:user_id (
          id,
          name,
          fcm_token
        )
      `)
      .eq("group_id", meeting.group_id)
      .eq("registration_status", "ACTIVE");

    if (groupUsersError) {
      console.error(`Error fetching group members for meeting ${meeting.id}:`, groupUsersError);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeMembers = (groupUsers || []).map((gu: any) => gu.users).filter(Boolean);

    // Formatação da mensagem
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meetingGroup = meeting.groups as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meetingBook = meeting.books as any;
    const groupName = meetingGroup?.number ? `Grupo ${meetingGroup.number}` : "seu grupo";
    const bookTitle = meetingBook?.name ? `"${meetingBook.name}"` : null;

    const notifTitle = "Lembrete do Encontro (em 1 semana)";
    const notifMessage = bookTitle
      ? `O encontro do ${groupName} sobre o livro ${bookTitle} acontece em 1 semana!`
      : `O encontro do ${groupName} acontece em 1 semana!`;

    // 2. Grava a notificação no histórico (public.notifications)
    const { data: createdNotif, error: notifInsertError } = await supabase
    // Reivindicação atômica para evitar disparos duplicados em execuções concorrentes
    const { data: claimedMeeting, error: claimError } = await supabase
      .from("meetings")
      .update({ reminder_1_week_sent: true })
      .eq("id", meeting.id)
      .eq("reminder_1_week_sent", false)
      .select("id")
      .maybeSingle();

    if (claimError) {
      console.error(
        `notify-upcoming-meetings claim meeting ${meeting.id}`,
        oneLine(claimError.message),
      );
      continue;
    }

    if (!claimedMeeting) {
      continue;
    }

    const { data: createdNotif, error: notifInsertError } = await supabase
      .from("notifications")
      .insert({
        title: notifTitle,
        message: notifMessage,
        type: "MEETING_REMINDER",
        scheduled_for: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (notifInsertError || !createdNotif) {
      console.error(
        `notify-upcoming-meetings insert notification ${meeting.id}`,
        oneLine(notifInsertError?.message ?? "missing created notification"),
      );
      await supabase
        .from("meetings")
        .update({ reminder_1_week_sent: false })
        .eq("id", meeting.id);
      continue;
    }

    const notifId = createdNotif?.id;
    let sentCount = 0;
    let invalidCount = 0;

    for (const member of activeMembers) {
      // 3. Associa a notificação ao usuário no histórico in-app
      if (notifId) {
        await supabase.from("notifications_targets").insert({
          notification_id: notifId,
          user_id: member.id,
          meeting_id: meeting.id,
          group_id: meeting.group_id,
        });
      }

      // 4. Dispara o Push FCM se tiver token
      if (member.fcm_token) {
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
                  token: member.fcm_token,
                  notification: {
                    title: notifTitle,
                    body: notifMessage,
                  },
                  data: {
                    meeting_id: String(meeting.id),
                    group_id: String(meeting.group_id),
                    type: "MEETING_REMINDER",
                  },
                  android: {
                    priority: "high",
                    notification: {
                      sound: "default",
                      channel_id: "meeting_reminders",
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
          } else {
            const errData = await fcmResponse.json();
            console.warn(`FCM error for user ${member.id}:`, errData);
            // Se o token expirou ou é inválido, limpa no banco
            const errorCode = errData?.error?.details?.[0]?.errorCode || errData?.error?.status;
            if (
              errorCode === "UNREGISTERED" ||
              errData?.error?.message?.includes("not a valid FCM registration token")
            ) {
              invalidCount++;
              await supabase
                .from("users")
                .update({ fcm_token: null })
                .eq("id", member.id);
            }
          }
        } catch (pushErr) {
          console.error(`Error sending push to user ${member.id}:`, pushErr);
        }
      }
    }

    // 5. Marca que o lembrete de 1 semana já foi enviado para este encontro
    await supabase
      .from("meetings")
      .update({ reminder_1_week_sent: true })
      .eq("id", meeting.id);

    results.push({
      meeting_id: meeting.id,
      notifications_sent: sentCount,
      tokens_invalid: invalidCount,
    });
  }

  return Response.json({
    success: true,
    processed_meetings: meetings.length,
    results,
  });
});
