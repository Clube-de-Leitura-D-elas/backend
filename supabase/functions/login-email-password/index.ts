import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  const { email, password } = await req.json();

  if (!email || !password) {
    return new Response(
      JSON.stringify({ error: 'email and password are required' }),
      { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

  const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    const { data: pendingUser } = await supabaseAdmin
      .from('pending_users')
      .select('id')
      .eq('email', email)
      .is('token_used_at', null)
      .maybeSingle();

    if (pendingUser) {
      return new Response(
        JSON.stringify({ error: 'account_not_activated' }),
        { status: 403 }
      );
    }

    return new Response(
      JSON.stringify({ error: 'invalid_credentials' }),
      { status: 401 }
    );
  }

  return new Response(JSON.stringify({ session: data.session }), { status: 200 });
});