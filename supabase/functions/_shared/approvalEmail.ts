import { type EmailResult, sendEmail } from "./email.ts";

export type ApprovalEmail = {
  to: string;
  name: string;
  claimToken: string;
};

/**
 * Monta o e-mail que avisa da aprovação e entrega o código de ativação.
 *
 * O envio fica em `_shared/email.ts`: em produção sai pelo Resend, em
 * desenvolvimento cai no Mailpit. Falhar aqui é motivo para desfazer a
 * aprovação — o fluxo é tudo-ou-nada.
 */
export async function sendApprovalEmail(
  email: ApprovalEmail,
): Promise<EmailResult> {
  // O nome vem do Google Forms: escapar evita que um `<` no nome quebre o HTML.
  const name = escapeHtml(email.name);

  return await sendEmail({
    to: email.to,
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
