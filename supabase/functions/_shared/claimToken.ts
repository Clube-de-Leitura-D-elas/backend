/**
 * Código de ativação que o e-mail de aprovação entrega à participante.
 *
 * 8 caracteres de um alfabeto de 32, sem `I`, `O`, `0` e `1`, que se confundem
 * ao transcrever um código de e-mail. São 2^40 combinações para um código que
 * expira em 7 dias e só pode ser usado uma vez.
 *
 * `crypto.getRandomValues` é um CSPRNG. O `md5(random())` que o trigger usava
 * não é: esse código dá acesso ao cadastro de uma pessoa.
 */
export const CLAIM_TOKEN_LENGTH = 8;

const CLAIM_TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateClaimToken(): string {
  const bytes = new Uint8Array(CLAIM_TOKEN_LENGTH);
  crypto.getRandomValues(bytes);

  // 256 é múltiplo de 32: o `% 32` não enviesa o sorteio.
  let token = "";
  for (const byte of bytes) token += CLAIM_TOKEN_ALPHABET[byte % 32];
  return token;
}
