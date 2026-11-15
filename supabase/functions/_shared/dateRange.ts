const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DateRange = { from: string; to: string };

/** Milissegundos UTC de uma data civil YYYY-MM-DD, ou null se não existir. */
function parseDate(value: string | null): number | null {
  if (!value || !DATE_REGEX.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  // Date.parse aceita 2026-02-30 e rola para março; a ida e volta pega isso.
  if (Number.isNaN(time)) return null;
  if (new Date(time).toISOString().slice(0, 10) !== value) return null;
  return time;
}

/**
 * Lê `from` e `to` (YYYY-MM-DD, inclusivos) da query string.
 * Retorna uma Response 400 para devolver direto se faltarem, forem datas
 * inexistentes, `from` for depois de `to` ou o intervalo passar de `maxDays`.
 */
export function readDateRangeParams(
  url: URL,
  { maxDays }: { maxDays: number },
): DateRange | Response {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromTime = parseDate(from);
  const toTime = parseDate(to);

  if (fromTime === null || toTime === null) {
    return Response.json(
      { error: 'missing/invalid "from" or "to" (expected YYYY-MM-DD)' },
      { status: 400 },
    );
  }
  if (fromTime > toTime) {
    return Response.json({ error: '"from" must not be after "to"' }, {
      status: 400,
    });
  }
  if ((toTime - fromTime) / DAY_MS > maxDays) {
    return Response.json(
      { error: `date range must not exceed ${maxDays} days` },
      { status: 400 },
    );
  }

  return { from: from as string, to: to as string };
}
