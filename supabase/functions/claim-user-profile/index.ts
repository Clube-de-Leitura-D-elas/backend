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
  // 1. Resolve City and Zone
  let cityId = null;
  if (pendingUser.city) {
    let { data: cityData } = await supabaseAdmin.from('cities').select('id').ilike('name', pendingUser.city).maybeSingle();
    if (!cityData) {
      const { data: newCity } = await supabaseAdmin.from('cities').insert({
        name: pendingUser.city,
        uf: 'RS'
      }).select('id').single();
      cityData = newCity;
    }
    cityId = cityData?.id;
  } else {
    // default city if null since city_id is NOT NULL
    const { data: fallbackCity } = await supabaseAdmin.from('cities').select('id').limit(1).single();
    cityId = fallbackCity?.id;
  }
  let zoneId = null;
  if (pendingUser.zone && cityId) {
    let { data: zoneData } = await supabaseAdmin.from('zones').select('id').ilike('name', pendingUser.zone).eq('city_id', cityId).maybeSingle();
    if (!zoneData) {
      const { data: newZone } = await supabaseAdmin.from('zones').insert({
        name: pendingUser.zone,
        city_id: cityId
      }).select('id').single();
      zoneData = newZone;
    }
    zoneId = zoneData?.id;
  }
  // 2. Resolve Education Enum
  let educationLevel = 'HIGH_SCHOOL';
  const eduStr = pendingUser.level_of_education?.toLowerCase() || '';
  if (eduStr.includes('superior')) educationLevel = 'UNDERGRADUATE';
  else if (eduStr.includes('fundamental')) educationLevel = 'ELEMENTARY';
  else if (eduStr.includes('médio')) educationLevel = 'HIGH_SCHOOL';
  else if (eduStr.includes('pós') || eduStr.includes('pos')) educationLevel = 'POSTGRADUATE';
  else if (eduStr.includes('técnico')) educationLevel = 'TECHNICAL';
  // 3. Insert User
  const newUserId = crypto.randomUUID();
  const { error: insertError } = await supabaseAdmin.from('users').insert([
    {
      id: newUserId,
      name: pendingUser.name,
      email: pendingUser.email,
      phone: pendingUser.phone_number,
      birth_date: pendingUser.birthday,
      job: pendingUser.job,
      level_of_education: educationLevel,
      instagram: pendingUser.instagram_user || '',
      city_id: cityId,
      zone_id: zoneId,
      book_name: pendingUser.book_name || null,
      is_active: true,
      user_id: user.id
    }
  ]);
  if (insertError) {
    console.error("Insert error:", insertError);
    return new Response(JSON.stringify({
      error: insertError.message
    }), {
      status: 500
    });
  }
  // 4. Update Pending User
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
