import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "update-meeting-promo-text";
const MAX_PROMO_TEXT_LENGTH = 2000;

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  if (!isUuid(meetingId)) {
    return badRequest('missing/invalid "meeting_id"');
  }

  const raw = body?.promo_text ?? null;
  if (raw !== null && typeof raw !== "string") {
    return badRequest('invalid "promo_text"');
  }
  // Texto vazio limpa o campo: o app usa null como "nada anexado".
  const promoText = raw?.trim() ? raw.trim() : null;
  if (promoText && promoText.length > MAX_PROMO_TEXT_LENGTH) {
    return badRequest(
      `"promo_text" exceeds the maximum of ${MAX_PROMO_TEXT_LENGTH} characters`,
    );
  }

  const meeting = await requireMeetingRecordManager(ctx, meetingId, LOG_LABEL);
  if (meeting instanceof Response) return meeting;

  const { error } = await ctx.supabaseAdmin
    .from("meetings")
    .update({ promo_text: promoText })
    .eq("id", meetingId);
  if (error) {
    console.error(`${LOG_LABEL} update error`, oneLine(error.message));
    return Response.json({ error: "Unable to update promo text" }, {
      status: 500,
    });
  }

  return Response.json({ meeting_id: meetingId, promo_text: promoText });
}));

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}
