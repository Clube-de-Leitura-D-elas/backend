import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { requireFounder } from "../_shared/founder.ts";
import { parseListParams } from "../_shared/pagination.ts";
// Lista paginada de solicitações pendentes (pending_users ainda não aprovadas).
// Query string: page, pageSize, order, search.
Deno.serve(withSupabase({
  auth: "user"
}, async (req, ctx)=>{
  const denied = await requireFounder(ctx);
  if (denied) return denied;
  const url = new URL(req.url);
  const { from, to, order } = parseListParams(url);
  const search = url.searchParams.get("search") ?? "";
  let query = ctx.supabaseAdmin.from("pending_users").select("id, name, city, phone_number, instagram_user", {
    count: "exact"
  }).eq("is_approved", false);
  if (search) query = query.ilike("name", `%${search}%`);
  const { data, error, count } = await query.order(order.column, {
    ascending: order.ascending
  }).order("id").range(from, to);
  if (error) {
    console.error("get-pending-participants error", error);
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
