import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { isUf, MAX_LOCATION_NAME_LENGTH } from "../_shared/city.ts";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { requireRole } from "../_shared/role.ts";

const STATUS_FILTER: Record<string, boolean | null> = {
  all: null,
  active: true,
  inactive: false,
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const url = new URL(req.url);
  const { from, to } = parseListParams(url);

  const search = url.searchParams.get("search")?.trim() ?? "";
  if (search.length > MAX_LOCATION_NAME_LENGTH) {
    return Response.json({ error: 'invalid "search"' }, { status: 400 });
  }

  const rawUf = url.searchParams.get("uf");
  const uf = rawUf && rawUf !== "all" ? rawUf : null;
  if (uf !== null && !isUf(uf)) {
    return Response.json({ error: 'invalid "uf"' }, { status: 400 });
  }

  const status = url.searchParams.get("status") ?? "all";
  if (!(status in STATUS_FILTER)) {
    return Response.json({ error: 'invalid "status"' }, { status: 400 });
  }

  const denied = await requireRole(ctx, ["MANAGER", "FOUNDER"], "management");
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin.rpc("list_cities", {
    p_search: search || null,
    p_uf: uf,
    p_is_active: STATUS_FILTER[status],
    p_limit: to - from + 1,
    p_offset: from,
  });

  if (error) {
    console.error("get-cities-web list", oneLine(error.message));
    return Response.json({ error: "Unable to load cities" }, { status: 500 });
  }

  return Response.json(data);
}));
