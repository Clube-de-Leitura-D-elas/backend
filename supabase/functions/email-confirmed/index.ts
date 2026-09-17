import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(async (_req)=>{
  return Response.redirect("https://confirm.clubedeleituradelas.me", 307);
});
