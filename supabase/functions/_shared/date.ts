const SAO_PAULO = "America/Sao_Paulo";

/**
 * Data civil (YYYY-MM-DD) de um timestamp, no fuso do clube.
 *
 * O painel web renderiza datas sem hora com `timeZone: 'UTC'`; devolver o
 * timestamp cru mostraria o dia anterior para o que foi registrado à noite em
 * São Paulo.
 */
export function toLocalDate(
  timestamp: string | null | undefined,
): string | null {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  // en-CA formata como YYYY-MM-DD.
  return date.toLocaleDateString("en-CA", { timeZone: SAO_PAULO });
}
