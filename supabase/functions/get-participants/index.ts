import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { parseListParams } from "../_shared/pagination.ts";
// Lista paginada de participantes (tabela users) para o painel web.
// Query string: page, pageSize, order, search, cityId, groupId.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const { from, to, order } = parseListParams(url);
  const search = url.searchParams.get("search") ?? "";
  const cityId = url.searchParams.get("cityId") ?? "";
  const groupId = url.searchParams.get("groupId") ?? "";
  const columns = groupId ? "id, name, is_active, group_users(id), in_group:group_users!inner(group_id)" : "id, name, is_active, group_users(id)";
  let query = ctx.supabaseAdmin.from("users").select(columns, {
    count: "exact"
  });
  if (search) query = query.ilike("name", `%${search}%`);
  if (cityId) query = query.eq("city_id", cityId);
  if (groupId) query = query.eq("in_group.group_id", groupId);
  const { data, error, count } = await query.order(order.column, {
    ascending: order.ascending
  }).order("id").range(from, to);
  if (error) {
    console.error("get-participants error", error);
    return Response.json({
      error: error.message
    }, {
      status: 400
    });
  }
  return Response.json({
    items: data,
    total: count ?? 0
  });
}));
