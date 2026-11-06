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

export function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SAO_PAULO })
    .format(new Date());
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function isFutureOrNowInstant(
  timestamp: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return !Number.isNaN(parsed) && parsed >= nowMs;
}
