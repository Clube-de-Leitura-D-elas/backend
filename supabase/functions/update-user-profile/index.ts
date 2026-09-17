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
        Authorization: authHeader || ''
      }
    }
  });
  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({
      error: 'Unauthorized'
    }), {
      status: 401,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const body = await req.json();
    const { name, email, phone, birth_date, job, level_of_education, city_name, zone_name, instagram, suggested_book } = body;
    // Resolve City ID
    let cityId = null;
    if (city_name) {
      let { data: cityData } = await supabaseAdmin.from('cities').select('id').ilike('name', city_name).maybeSingle();
      if (!cityData) {
        const { data: newCity } = await supabaseAdmin.from('cities').insert({
          name: city_name,
          uf: 'RS'
        }).select('id').single();
        cityData = newCity;
      }
      cityId = cityData?.id;
    }
    // Resolve Zone ID
    let zoneId = null;
    if (zone_name && cityId) {
      let { data: zoneData } = await supabaseAdmin.from('zones').select('id').ilike('name', zone_name).eq('city_id', cityId).maybeSingle();
      if (!zoneData) {
        const { data: newZone } = await supabaseAdmin.from('zones').insert({
          name: zone_name,
          city_id: cityId
        }).select('id').single();
        zoneData = newZone;
      }
      zoneId = zoneData?.id;
    }
    // Update public.users
    const updatePayload = {};
    if (name) updatePayload.name = name;
    if (email) updatePayload.email = email;
    if (phone) updatePayload.phone = phone;
    if (birth_date) updatePayload.birth_date = birth_date;
    if (job !== undefined) updatePayload.job = job;
    if (level_of_education !== undefined) updatePayload.level_of_education = level_of_education;
    if (instagram !== undefined) updatePayload.instagram = instagram;
    if (cityId) updatePayload.city_id = cityId;
    if (zoneId !== undefined) updatePayload.zone_id = zoneId;
    if (suggested_book !== undefined) updatePayload.book_name = suggested_book;
    const { data: userProfile, error: updateError } = await supabaseAdmin.from('users').update(updatePayload).eq('user_id', user.id).select('*').single();
    if (updateError) {
      return new Response(JSON.stringify({
        error: updateError.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      profile: userProfile
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message || 'Internal error'
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
