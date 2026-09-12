import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req)=>{
  const { name, email, address, phone_number, birthday, job, level_of_education, instagram_user, book_name } = await req.json();
  const supabaseUrl = Deno.env.get('SUPABASE_URL') as string;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  
  const { data, error } = await supabase.from('pending_users').insert([
    {
      name,
      email,
      address,
      phone_number,
      birthday,
      job,
      level_of_education,
      instagram_user,
      book_name,
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
    data
  }), {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  });
});
