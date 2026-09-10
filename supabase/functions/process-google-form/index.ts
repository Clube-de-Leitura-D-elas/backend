import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
serve(async (req)=>{
  const { name, email, address, phone_number } = await req.json();
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const claimToken = crypto.randomUUID().split('-')[0].toUpperCase();
  const { data, error } = await supabase.from('pending_users').insert([
    {
      name,
      email,
      address,
      phone_number,
      claim_token: claimToken,
      is_approved: false
    }
  ]).select();
  if (error) return new Response(JSON.stringify({
    error: error.message
  }), {
    status: 400
  });
  return new Response(JSON.stringify({
    success: true,
    claim_token: claimToken
  }), {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  });
});
