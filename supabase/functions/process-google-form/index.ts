import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

const encoder = new TextEncoder();

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = a.length ^ b.length;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

function readOptionalString(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const expectedSecret = Deno.env.get("GOOGLE_FORM_WEBHOOK_SECRET");
  const providedSecret = req.headers.get("x-webhook-secret");
  if (
    !expectedSecret ||
    !providedSecret ||
    !(await timingSafeEqualStrings(providedSecret, expectedSecret))
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = readOptionalString(body?.name, 200);
  const email = readOptionalString(body?.email, 320);
  if (!name || !email) {
    return Response.json(
      { error: 'missing/invalid "name" or "email"' },
      { status: 400 },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") as string;
  const supabaseServiceKey = Deno.env.get(
    "SUPABASE_SERVICE_ROLE_KEY",
  ) as string;
  const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey);

  const { data, error } = await supabase
    .from("pending_users")
    .insert([
      {
        name,
        email,
        city: readOptionalString(body?.city, 120),
        zone: readOptionalString(body?.zone, 120),
        phone_number: readOptionalString(body?.phone_number, 40),
        birthday: readOptionalString(body?.birthday, 40),
        job: readOptionalString(body?.job, 200),
        level_of_education: readOptionalString(body?.level_of_education, 120),
        instagram_user: readOptionalString(body?.instagram_user, 120),
        book_name: readOptionalString(body?.book_name, 300),
        is_approved: false,
      },
    ])
    .select();

  if (error) {
    console.error("process-google-form insert error", oneLine(error.message));
    return Response.json(
      { error: "Unable to process registration" },
      { status: 500 },
    );
  }

  return Response.json({
    success: true,
    data,
  });
});
