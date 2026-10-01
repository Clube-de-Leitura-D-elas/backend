/**
 * Mensagem de erro pronta para `console.error`.
 *
 * Tira quebras de linha: sem isso, uma mensagem do Postgres com várias linhas
 * vira várias entradas soltas no log da função.
 */
export const oneLine = (message: string) => message.replace(/[\r\n]/g, " ");
