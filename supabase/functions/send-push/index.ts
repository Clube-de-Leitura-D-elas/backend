import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { type PushMessage, sendFcmMessage } from "../_shared/fcm.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "send-push";
const MAX_TARGETS = 500;
// Envios simultâneos ao FCM: sem limite, um aviso para o clube inteiro abriria
// centenas de conexões de uma vez.
const SEND_CONCURRENCY = 20;

type TargetRow = {
  id: string;
  user_id: string;
  meeting_id: string | null;
  group_id: string | null;
  notifications: { title: string; message: string; type: string };
};

type Delivery = { target: TargetRow; token: string };

// Manda por push as linhas de notifications_targets recebidas em `target_ids`.
// Só o banco chama esta function (trigger e agendador, via pg_net, com a chave
// secreta do projeto no header apikey): `auth: "secret"` recusa leitoras,
// chave anon e chamadas sem credencial. Falha de envio nunca desfaz nada, a
// notificação in-app já está gravada; só gera log.
Deno.serve(withSupabase<Database>({ auth: "secret" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const targetIds = await readTargetIds(req);
  if (!targetIds) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }

  // O filtro de scheduled_for repete a regra do banco de propósito: aviso
  // agendado para o futuro não sai por push, mesmo que alguém chame a function
  // com o id dele.
  const { data: targetData, error: targetError } = await ctx.supabaseAdmin
    .from("notifications_targets")
    .select(
      "id, user_id, meeting_id, group_id, notifications!inner(title, message, type, scheduled_for)",
    )
    .in("id", targetIds)
    .lte("notifications.scheduled_for", new Date().toISOString());

  if (targetError) {
    console.error(`${LOG_LABEL} targets error`, oneLine(targetError.message));
    return serverError();
  }
  const targets = (targetData ?? []) as unknown as TargetRow[];
  if (targets.length === 0) return Response.json(summary([]));

  const userIds = [...new Set(targets.map((target) => target.user_id))];
  const { data: deviceData, error: deviceError } = await ctx.supabaseAdmin
    .from("user_devices")
    .select("user_id, fcm_token")
    .in("user_id", userIds);

  if (deviceError) {
    console.error(`${LOG_LABEL} devices error`, oneLine(deviceError.message));
    return serverError();
  }

  const tokensByUser = new Map<string, string[]>();
  for (const device of deviceData ?? []) {
    const tokens = tokensByUser.get(device.user_id) ?? [];
    tokens.push(device.fcm_token);
    tokensByUser.set(device.user_id, tokens);
  }

  const deliveries: Delivery[] = targets.flatMap((target) =>
    (tokensByUser.get(target.user_id) ?? []).map((token) => ({ target, token }))
  );

  const results: string[] = [];
  const invalidTokens: string[] = [];
  for (let i = 0; i < deliveries.length; i += SEND_CONCURRENCY) {
    const batch = deliveries.slice(i, i + SEND_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map(({ target, token }) =>
        sendFcmMessage(token, buildMessage(target))
      ),
    );

    outcomes.forEach((outcome, index) => {
      results.push(outcome.status);
      if (outcome.status === "invalid_token") {
        invalidTokens.push(batch[index].token);
      } else if (outcome.status !== "sent") {
        console.error(
          `${LOG_LABEL} ${outcome.status}`,
          oneLine(outcome.reason),
        );
      }
    });
  }

  // O FCM disse que o token não existe mais: sai de user_devices para as
  // próximas notificações não tentarem de novo. Falha aqui só gera log.
  if (invalidTokens.length > 0) {
    const { error: deleteError } = await ctx.supabaseAdmin
      .from("user_devices")
      .delete()
      .in("fcm_token", invalidTokens);
    if (deleteError) {
      console.error(
        `${LOG_LABEL} invalid token delete error`,
        oneLine(deleteError.message),
      );
    }
  }

  return Response.json(summary(results));
}));

async function readTargetIds(req: Request): Promise<string[] | null> {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return null;
  }

  const ids = body?.target_ids;
  if (
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TARGETS ||
    !ids.every(isUuid)
  ) {
    return null;
  }

  return [...new Set(ids)];
}

// Contrato com o app: `data` só aceita string, então valor ausente vai vazio.
// notification_target_id é o mesmo id da get-my-notifications, que o app usa
// para chamar mark-notification-read.
function buildMessage(target: TargetRow): PushMessage {
  return {
    title: target.notifications.title,
    body: target.notifications.message,
    data: {
      notification_target_id: target.id,
      type: target.notifications.type,
      meeting_id: target.meeting_id ?? "",
      group_id: target.group_id ?? "",
    },
  };
}

function summary(results: string[]) {
  const count = (status: string) =>
    results.filter((result) => result === status).length;
  return {
    sent: count("sent"),
    invalid_token: count("invalid_token"),
    temporary: count("temporary"),
    failed: count("failed"),
  };
}

function serverError(): Response {
  return Response.json({ error: "Unable to send push" }, { status: 500 });
}
