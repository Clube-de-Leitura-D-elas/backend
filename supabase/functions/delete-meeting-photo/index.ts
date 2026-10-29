import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { MEETING_PHOTOS_BUCKET } from "../_shared/meetingPhoto.ts";
import { requireMeetingRecordManager } from "../_shared/meetingRecord.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "delete-meeting-photo";

type Ctx = SupabaseContext<Database>;

type MeetingPhotoRow = { photo_id: string; photos: { url: string } | null };

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
  const photoId = body?.photo_id;
  if (!isUuid(photoId)) {
    return badRequest('missing/invalid "photo_id"');
  }

  const allowed = await requireMeetingRecordManager(ctx, meetingId, LOG_LABEL);
  if (allowed instanceof Response) return allowed;

  const { data, error } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .select("photo_id, photos(url)")
    .eq("meeting_id", meetingId)
    .eq("photo_id", photoId.toLowerCase())
    .maybeSingle();
  if (error) {
    logError("lookup error", error.message);
    return serverError();
  }
  if (!data) {
    // Uma remoção anterior pode ter apagado a foto e falhado ao reabrir o
    // registro; refazer a reabertura aqui destrava esse caso no retry.
    const reopened = await reopenRecordWhenEmpty(ctx, meetingId);
    if (reopened instanceof Response) return reopened;
    return Response.json({ error: "photo not found in this meeting" }, {
      status: 404,
    });
  }

  const row = data as unknown as MeetingPhotoRow;
  const deleteError = await deletePhotoRows(ctx, row.photo_id);
  if (deleteError) return deleteError;

  await removeStorageObject(ctx, meetingId, row.photos?.url);

  const status = await reopenRecordWhenEmpty(ctx, meetingId);
  if (status instanceof Response) return status;

  return Response.json({ meeting_id: meetingId, photo_id: row.photo_id, status });
}));

async function deletePhotoRows(
  ctx: Ctx,
  photoId: string,
): Promise<Response | null> {
  const { error: linkError } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .delete()
    .eq("photo_id", photoId);
  if (linkError) {
    logError("link delete error", linkError.message);
    return serverError();
  }

  const { error: photoError } = await ctx.supabaseAdmin
    .from("photos")
    .delete()
    .eq("id", photoId);
  if (photoError) logError("photo delete error", photoError.message);
  return null;
}

async function removeStorageObject(
  ctx: Ctx,
  meetingId: string,
  path: string | undefined,
) {
  if (!path?.startsWith(`meetings/${meetingId}/`)) return;
  const { error } = await ctx.supabaseAdmin.storage
    .from(MEETING_PHOTOS_BUCKET)
    .remove([path]);
  if (error) logError("storage remove error", error.message);
}

// Sem nenhuma foto oficial, o registro volta a ficar pendente:
// CONCLUDED -> ENDED, o inverso do que a add-meeting-photo faz.
// Devolve o status do encontro depois da checagem.
async function reopenRecordWhenEmpty(
  ctx: Ctx,
  meetingId: string,
): Promise<string | Response> {
  const { count, error } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .select("photo_id", { count: "exact", head: true })
    .eq("meeting_id", meetingId)
    .eq("is_sketch", false);
  if (error) {
    logError("count error", error.message);
    return serverError();
  }
  if ((count ?? 0) === 0) {
    const { error: updateError } = await ctx.supabaseAdmin
      .from("meetings")
      .update({ status: "ENDED" })
      .eq("id", meetingId)
      .eq("status", "CONCLUDED");
    if (updateError) {
      logError("reopen error", updateError.message);
      return serverError();
    }
  }

  const { data, error: statusError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("status")
    .eq("id", meetingId)
    .single();
  if (statusError) {
    logError("status error", statusError.message);
    return serverError();
  }
  return data.status as string;
}

function logError(label: string, message: string) {
  console.error(`${LOG_LABEL} ${label}`, oneLine(message));
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(): Response {
  return Response.json({ error: "Unable to delete meeting photo" }, {
    status: 500,
  });
}
