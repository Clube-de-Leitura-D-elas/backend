import { Resend } from "npm:resend@4.0.0";

export type Email = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type EmailResult = { sent: true } | { sent: false; error: string };

const DEFAULT_FROM = "nao-responda@clubedeleitura.local";

// Hostname interno do Mailpit do `supabase start`. Só resolve de dentro da rede
// do stack, que é onde as functions rodam; da máquina, a UI é 127.0.0.1:54324.
const DEFAULT_MAILPIT_URL = "http://supabase_inbucket_backend:8025";

// Prazo do envio. Sem ele, um provedor que aceita a conexão e não responde
// prende a rota depois que a aprovação já foi gravada: nem resposta, nem
// desfazer, e o retry seguinte só devolve "já aprovada".
const SEND_TIMEOUT_MS = 10_000;

/**
 * Envia um e-mail pelo canal escolhido em `EMAIL_DRIVER`:
 *
 * - `resend` (default, produção): exige `RESEND_API_KEY` e `EMAIL_FROM`.
 * - `mailpit` (desenvolvimento): entrega no Mailpit que o `supabase start` já
 *   sobe, sem chave. Use `EMAIL_DRIVER=mailpit` no `.env.local`.
 *
 * As variáveis são lidas na chamada, não na importação: quem chama decide o que
 * fazer quando o envio falha (a aprovação, por exemplo, é desfeita).
 */
export async function sendEmail(email: Email): Promise<EmailResult> {
  const driver = (Deno.env.get("EMAIL_DRIVER") ?? "resend").toLowerCase();

  try {
    if (driver === "mailpit") return await sendWithMailpit(email);
    if (driver === "resend") return await sendWithResend(email);
    return { sent: false, error: `unknown EMAIL_DRIVER "${driver}"` };
  } catch (error) {
    // `fetch` estoura em erro de rede; o contrato aqui é sempre um resultado.
    return {
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sendWithResend(email: Email): Promise<EmailResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return { sent: false, error: "RESEND_API_KEY is not configured" };
  }

  const from = Deno.env.get("EMAIL_FROM");
  if (!from) return { sent: false, error: "EMAIL_FROM is not configured" };

  // O SDK (v4) não aceita timeout nem signal, então a espera é limitada por
  // corrida. A requisição em voo não é abortada: se ela vencer depois, o e-mail
  // pode chegar com um código que já foi desfeito — o fluxo é at-most-once.
  const { error } = await withTimeout(
    new Resend(apiKey).emails.send({
      from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      html: email.html,
    }),
    SEND_TIMEOUT_MS,
  );

  if (error) return { sent: false, error: error.message ?? String(error) };
  return { sent: true };
}

async function sendWithMailpit(email: Email): Promise<EmailResult> {
  const baseUrl = (Deno.env.get("MAILPIT_URL") ?? DEFAULT_MAILPIT_URL).replace(
    /\/+$/,
    "",
  );
  const from = Deno.env.get("EMAIL_FROM") ?? DEFAULT_FROM;

  const response = await fetch(`${baseUrl}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    body: JSON.stringify({
      From: { Email: from },
      To: [{ Email: email.to }],
      Subject: email.subject,
      Text: email.text,
      HTML: email.html,
    }),
  });

  if (!response.ok) {
    return { sent: false, error: `mailpit responded ${response.status}` };
  }

  return { sent: true };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`email send timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
