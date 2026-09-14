import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const ORDER_BY: Record<string, { column: string; ascending: boolean }> = {
  name_asc: { column: 'name', ascending: true },
  name_desc: { column: 'name', ascending: false },
  newest: { column: 'created_at', ascending: false },
};

Deno.serve(withSupabase({ auth: 'secret' }, async (req, ctx) => {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from('users')
    .select('app_role')
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (profileError || !profile || profile.app_role !== 'FOUNDER') {
    return new Response(JSON.stringify({ error: 'Forbidden: founder only' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const pageSize = Math.max(1, Number(url.searchParams.get('pageSize') ?? 6));
  const search = url.searchParams.get('search') ?? '';
  const order = (url.searchParams.get('order') ?? 'name_asc') as keyof typeof ORDER_BY;
  const orderDef = ORDER_BY[order] ?? ORDER_BY.name_asc;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = ctx.supabaseAdmin
    .from('pending_users')
    .select('id, name, city, phone_number, instagram_user', { count: 'exact' })
    .eq('is_approved', false);

  if (search) query = query.ilike('name', `%${search}%`);

  const { data, error, count } = await query
    .order(orderDef.column, { ascending: orderDef.ascending })
    .order('id')
    .range(from, to);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ items: data, total: count ?? 0 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}));
