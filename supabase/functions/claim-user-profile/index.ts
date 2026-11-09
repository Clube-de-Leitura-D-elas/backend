import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const INVALID_TOKEN = "CL001";
const USER_ALREADY_EXISTS = "CL002";

serve(async (req) => {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const claimToken = body?.claim_token;
  if (typeof claimToken !== "string" || claimToken.length === 0) {
    return Response.json({ error: "missing claim_token" }, { status: 400 });
  }

  const authHeader = req.headers.get('Authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL') as string;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
  const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') as string, {
    global: {
      headers: {
        Authorization: authHeader!
      }
    }
  });

  const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
  if (authError || !user) return new Response(JSON.stringify({
    error: 'Unauthorized'
  }), {
    status: 401
  });

  const { error: claimError } = await supabaseAdmin.rpc("claim_user_profile", {
    p_claim_token: claimToken,
    p_user_id: user.id,
  });

  if (claimError) {
    if (claimError.code === INVALID_TOKEN) {
      return new Response(JSON.stringify({
        error: 'Token inválido ou já utilizado'
      }), {
        status: 400
      });
    }
    if (claimError.code === USER_ALREADY_EXISTS) {
      return new Response(JSON.stringify({
        error: 'Não foi possível concluir o cadastro'
      }), {
        status: 409
      });
    }
    console.error("RPC error:", claimError);
    return new Response(JSON.stringify({
      error: 'Não foi possível concluir o cadastro'
    }), {
      status: 500
    });
  }

  return new Response(JSON.stringify({
    success: true
  }), {
    headers: {
      "Content-Type": "application/json"
    },
    status: 200
  });
});
