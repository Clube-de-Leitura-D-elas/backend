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

/** Horário do encontro em São Paulo: "12/11, 19h" ou "12/11, 19h30". */
export function formatMeetingWhen(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: SAO_PAULO,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;

  const day = value("day");
  const month = value("month");
  const hour = value("hour");
  const minute = value("minute");
  if (!day || !month || !hour || !minute) return null;

  const clock = minute === "00"
    ? `${Number(hour)}h`
    : `${Number(hour)}h${minute}`;
  return `${day}/${month}, ${clock}`;
}
