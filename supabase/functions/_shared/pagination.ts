const MAX_PAGE_SIZE = 100;

export const ORDER_BY: Record<string, { column: string; ascending: boolean }> = {
  name_asc: { column: "name", ascending: true },
  name_desc: { column: "name", ascending: false },
  newest: { column: "created_at", ascending: false },
};

const toPositiveInt = (value: string | null, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Lê `page`, `pageSize` e `order` da query string e devolve o intervalo
 * inclusivo para `.range(from, to)` do supabase-js.
 */
export function parseListParams(url: URL) {
  const page = toPositiveInt(url.searchParams.get("page"), 1);
  const pageSize = Math.min(toPositiveInt(url.searchParams.get("pageSize"), 6), MAX_PAGE_SIZE);
  const order = ORDER_BY[url.searchParams.get("order") ?? ""] ?? ORDER_BY.name_asc;

  const from = (page - 1) * pageSize;
  return { from, to: from + pageSize - 1, order };
}
