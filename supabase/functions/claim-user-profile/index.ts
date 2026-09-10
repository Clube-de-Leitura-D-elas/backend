import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
serve(async (req)=>{
  const authHeader = req.headers.get('Authorization');
  const { claim_token } = await req.json();
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
  const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY'), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) return new Response(JSON.stringify({
    error: 'Unauthorized'
  }), {
    status: 401
  });
  const { data: pendingUser, error: pendingError } = await supabaseAdmin.from('pending_users').select('*').eq('claim_token', claim_token).eq('is_approved', true).is('token_used_at', null).single();
  if (pendingError || !pendingUser) {
    return new Response(JSON.stringify({
      error: 'Token inválido ou já utilizado'
    }), {
      status: 400
    });
  }
  const { error: insertError } = await supabaseAdmin.from('users').insert([
    {
      id: crypto.randomUUID(),
      name: pendingUser.name,
      email: pendingUser.email,
      adress: pendingUser.address,
      phone_number: pendingUser.phone_number,
      is_Active: true,
      user_id: user.id
    }
  ]);
  if (insertError) return new Response(JSON.stringify({
    error: insertError.message
  }), {
    status: 500
  });
  await supabaseAdmin.from('pending_users').update({
    token_used_at: new Date().toISOString()
  }).eq('id', pendingUser.id);
  return new Response(JSON.stringify({
    success: true
  }), {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  });
});
