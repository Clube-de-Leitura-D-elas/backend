import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { isUuid } from "../_shared/uuid.ts";

type ParticipantRow = {
  id: string;
  name: string;
  is_active: boolean;
  status: "active" | "inactive" | "awaiting_account";
  group_user_ids: string[];
};

type ParticipantListResult = { items: ParticipantRow[]; total: number };

// Lista paginada de participantes para o painel web: `users` mais as solicitações aprovadas
// que ainda não viraram conta (status `awaiting_account`).
// Query string: page, pageSize, order, search, cityId, groupId.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const url = new URL(req.url);
  const { from, to, order } = parseListParams(url);
  const search = url.searchParams.get("search") ?? "";
  const cityId = url.searchParams.get("cityId") ?? "";
  const groupId = url.searchParams.get("groupId") ?? "";

  if (cityId && !isUuid(cityId)) {
    return Response.json({ error: 'invalid "cityId"' }, { status: 400 });
  }
  if (groupId && !isUuid(groupId)) {
    return Response.json({ error: 'invalid "groupId"' }, { status: 400 });
  }

  const denied = await requireFounder(ctx);
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin.rpc("list_participants_web", {
    p_search: search,
    p_city_id: cityId || null,
    p_group_id: groupId || null,
    p_order_column: order.column,
    p_ascending: order.ascending,
    p_limit: to - from + 1,
    p_offset: from,
  });

  if (error) {
    console.error("get-participants rpc", oneLine(error.message));
    return Response.json({ error: "unable to load participants" }, {
      status: 500,
    });
  }

  const result = data as unknown as ParticipantListResult;

  return Response.json({
    items: result.items.map(({ group_user_ids, ...item }) => ({
      ...item,
      group_users: group_user_ids.map((id) => ({ id })),
    })),
    total: Number(result.total),
  });
}));
