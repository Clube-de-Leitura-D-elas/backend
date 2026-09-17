import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
serve(async (req)=>{
  const authHeader = req.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
  const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401
    });
  }
  const { data: userProfile, error: profileError } = await supabaseAdmin.from('users').select('*, city:cities(name, uf), zone:zones(name)').eq('user_id', user.id).maybeSingle();
  if (profileError) {
    return new Response(JSON.stringify({
      error: profileError.message
    }), {
      status: 500
    });
  }
  return new Response(JSON.stringify({
    success: true,
    profile: userProfile
  }), {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  });
});
