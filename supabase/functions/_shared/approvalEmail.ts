import { Resend } from "npm:resend@4.0.0";

export type ApprovalEmail = {
  to: string;
  name: string;
  claimToken: string;
};

export type ApprovalEmailResult = { sent: true } | {
  sent: false;
  error: string;
};

/**
 * Envia o e-mail que avisa da aprovação e entrega o código de ativação.
 *
 * As variáveis são lidas na chamada, não na importação: sem `RESEND_API_KEY`
 * ou `EMAIL_FROM` o envio falha com um motivo logável, e quem chamou desfaz a
 * aprovação — a aprovação é tudo-ou-nada.
 */
export async function sendApprovalEmail(
  email: ApprovalEmail,
): Promise<ApprovalEmailResult> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  if (!apiKey) {
    return { sent: false, error: "RESEND_API_KEY is not configured" };
  }
  if (!from) return { sent: false, error: "EMAIL_FROM is not configured" };

  // O nome vem do Google Forms: escapar evita que um `<` no nome quebre o HTML.
  const name = escapeHtml(email.name);

  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: [email.to],
    subject: "Seu cadastro foi aprovado! 🎉",
    text: [
      `Olá ${email.name},`,
      "",
      "Seu cadastro no Clube de Leitura D'Elas foi aprovado!",
      "",
      `Seu Token de Acesso (Claim Token): ${email.claimToken}`,
      "",
      "Abra o aplicativo, faça login com sua conta Google e insira o Token de Acesso acima para vincular seu perfil.",
    ].join("\n"),
    html: `
      <p>Olá <b>${name}</b>,</p>
      <p>Seu cadastro no <b>Clube de Leitura D'Elas</b> foi aprovado com sucesso! 🎉</p>
      <p><b>Seu Token de Acesso:</b> <span style="font-size:18px;font-weight:bold;color:#E6256D;">${email.claimToken}</span></p>
      <p>Abra o aplicativo, faça login com sua conta Google e insira o Token de Acesso acima para vincular o seu perfil.</p>
    `,
  });

  if (error) return { sent: false, error: error.message ?? String(error) };
  return { sent: true };
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
