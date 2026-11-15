import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

const LOG_LABEL = "save-onboarding-review";

type ReviewUpdate = {
  expectations: string | null;
  hasOtherReadingGroup: boolean | null;
  wantsToCoordinate: boolean | null;
};

// Salva as três respostas da revisão que `update-user-profile` ainda não
// aceita. Fica numa function separada para não mexer no contrato das funções
// do PR #120; o app chama as duas em sequência.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const update = await readReviewUpdate(req);
  if (update instanceof Response) return update;

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) return serverError("profile", profileError);
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { error: updateError } = await ctx.supabaseAdmin
    .from("users")
    .update({
      expectations: update.expectations,
      has_other_reading_group: update.hasOtherReadingGroup,
      wants_to_coordinate: update.wantsToCoordinate,
    })
    .eq("id", profile.id);

  if (updateError) return serverError("update", updateError);

  return Response.json({ success: true });
}));

async function readReviewUpdate(
  req: Request,
): Promise<ReviewUpdate | Response> {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return badRequest("expected JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected JSON body");
  }

  const expectations = readOptionalText(body.expectations, "expectations");
  if (expectations instanceof Response) return expectations;

  const hasOtherReadingGroup = readOptionalBoolean(
    body.has_other_reading_group,
    "has_other_reading_group",
  );
  if (hasOtherReadingGroup instanceof Response) return hasOtherReadingGroup;

  const wantsToCoordinate = readOptionalBoolean(
    body.wants_to_coordinate,
    "wants_to_coordinate",
  );
  if (wantsToCoordinate instanceof Response) return wantsToCoordinate;

  return { expectations, hasOtherReadingGroup, wantsToCoordinate };
}

function readOptionalText(
  value: unknown,
  field: string,
): string | null | Response {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" || !value.isWellFormed() || value.includes("\0")
  ) {
    return badRequest(`invalid "${field}"`);
  }

  return value.trim() || null;
}

function readOptionalBoolean(
  value: unknown,
  field: string,
): boolean | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    return badRequest(`invalid "${field}"`);
  }
  return value;
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to save review" }, { status: 500 });
}
