import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { todayInSaoPaulo } from "../_shared/date.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { findMeetingGroupIdAndHostId } from "../_shared/meeting.ts";
import {
  MEETING_PHOTOS_BUCKET,
  signMeetingPhotos,
} from "../_shared/meetingPhoto.ts";
import {
  decodePhoto,
  EXTENSION_BY_CONTENT_TYPE,
  MAX_BASE64_LENGTH,
  MAX_BODY_BYTES,
  photoTooLarge,
} from "../_shared/photoUpload.ts";
import { isUuid } from "../_shared/uuid.ts";

const MAX_PHOTOS_PER_MEETING = 50;
const PHOTO_LIMIT_ERRCODE = "P0050";
const PHOTO_STATUSES = ["ENDED", "CONCLUDED"];

type Ctx = SupabaseContext<Database>;

type PhotoRequest = {
  meetingId: string;
  photoId: string;
  contentType: string;
  extension: string;
  encoded: string;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const request = await readPhotoRequest(req);
  if (request instanceof Response) return request;

  const meeting = await findMeetingGroupIdAndHostId(
    ctx,
    request.meetingId,
    "add-meeting-photo",
  );
  if (meeting instanceof Response) return meeting;

  const member = await requireGroupMemberProfile(
    ctx,
    meeting.groupId,
    { activeOnly: true },
  );
  if (member instanceof Response) return member;

  const result = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.groupId,
    member.profileId,
    meeting.hostId,
    "add-meeting-photo",
  );
  if (result instanceof Response) return result;
  if (!result) {
    return Response.json({
      error: "Forbidden: group coordinators or meeting host only.",
    }, {
      status: 403,
    });
  }

  // Mesma regra do can_add_photos da get-meeting-photos: o registro só
  // libera depois do encerramento.
  if (!PHOTO_STATUSES.includes(meeting.status)) {
    return Response.json({
      error: "photos can only be added after the meeting is ended",
    }, { status: 409 });
  }

  const existing = await findExistingPhoto(ctx, req, request);
  if (existing) return existing;

  const full = await rejectWhenMeetingIsFull(ctx, request.meetingId);
  if (full) return full;

  const bytes = decodePhoto(request.encoded, request.contentType, {
    encoded: "data_base64",
    contentType: "content_type",
  });
  if (bytes instanceof Response) return bytes;

  const response = await storePhoto(
    ctx,
    req,
    request,
    bytes,
    member.profileId,
  );
  // Enviar a foto oficial conclui o registro: ENDED -> CONCLUDED.
  if (response.status === 201) {
    const concludeError = await concludeMeeting(ctx, request.meetingId);
    if (concludeError) return concludeError;
  }
  return response;
}));

async function concludeMeeting(
  ctx: Ctx,
  meetingId: string,
): Promise<Response | null> {
  const { error } = await ctx.supabaseAdmin
    .from("meetings")
    .update({ status: "CONCLUDED" })
    .eq("id", meetingId)
    .eq("status", "ENDED");
  if (error) {
    logError("conclude error", error.message);
    return serverError();
  }
  return null;
}

async function readPhotoRequest(
  req: Request,
): Promise<PhotoRequest | Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return photoTooLarge();
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

  const photoId = body?.photo_id ?? crypto.randomUUID();
  if (!isUuid(photoId)) {
    return badRequest('invalid "photo_id"');
  }

  const contentType = body?.content_type;
  const extension = typeof contentType === "string"
    ? EXTENSION_BY_CONTENT_TYPE[contentType]
    : undefined;
  if (!extension) {
    return badRequest(
      'missing/invalid "content_type" (expected one of: ' +
        Object.keys(EXTENSION_BY_CONTENT_TYPE).join(", ") + ")",
    );
  }

  const encoded = body?.data_base64;
  if (typeof encoded !== "string" || encoded.length === 0) {
    return badRequest('missing/invalid "data_base64"');
  }
  if (encoded.length > MAX_BASE64_LENGTH) {
    return photoTooLarge();
  }

  return {
    meetingId,
    photoId: photoId.toLowerCase(),
    contentType: contentType as string,
    extension,
    encoded,
  };
}

async function findExistingPhoto(
  ctx: Ctx,
  req: Request,
  request: PhotoRequest,
): Promise<Response | null> {
  const { data, error } = await ctx.supabaseAdmin
    .from("photos")
    .select("id, url, meeting_photos(meeting_id)")
    .eq("id", request.photoId)
    .maybeSingle();

  if (error) {
    logError("existing photo error", error.message);
    return serverError();
  }
  if (!data) return null;

  const link = data.meeting_photos as unknown as { meeting_id: string } | null;
  if (link?.meeting_id !== request.meetingId) {
    return Response.json({ error: '"photo_id" already in use' }, {
      status: 422,
    });
  }

  return await signedPhotoResponse(
    ctx,
    req,
    request.meetingId,
    data.id,
    data.url,
    200,
  );
}

async function rejectWhenMeetingIsFull(
  ctx: Ctx,
  meetingId: string,
): Promise<Response | null> {
  const { count, error } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .select("photo_id", { count: "exact", head: true })
    .eq("meeting_id", meetingId);

  if (error) {
    logError("count error", error.message);
    return serverError();
  }
  return (count ?? 0) >= MAX_PHOTOS_PER_MEETING ? meetingIsFull() : null;
}

async function storePhoto(
  ctx: Ctx,
  req: Request,
  request: PhotoRequest,
  bytes: Uint8Array,
  uploadedBy: string,
): Promise<Response> {
  const objectPath =
    `meetings/${request.meetingId}/${request.photoId}.${request.extension}`;
  const storage = ctx.supabaseAdmin.storage.from(MEETING_PHOTOS_BUCKET);

  const { error: uploadError } = await storage.upload(objectPath, bytes, {
    contentType: request.contentType,
    upsert: true,
  });
  if (uploadError) {
    logError("upload error", uploadError.message);
    return serverError();
  }

  const insertError = await insertPhotoRows(
    ctx,
    request,
    objectPath,
    uploadedBy,
  );
  if (!insertError) {
    return await signedPhotoResponse(
      ctx,
      req,
      request.meetingId,
      request.photoId,
      objectPath,
      201,
    );
  }

  logError("insert error", insertError.message);
  if (insertError.code === "23505") return serverError();

  const { error: removeError } = await storage.remove([objectPath]);
  if (removeError) logError("cleanup error", removeError.message);

  return insertError.code === PHOTO_LIMIT_ERRCODE
    ? meetingIsFull()
    : serverError();
}

async function insertPhotoRows(
  ctx: Ctx,
  request: PhotoRequest,
  objectPath: string,
  uploadedBy: string,
): Promise<{ code?: string; message: string } | null> {
  const { error: photoError } = await ctx.supabaseAdmin
    .from("photos")
    .insert({
      id: request.photoId,
      url: objectPath,
      file_extension: request.extension,
      uploaded_at: todayInSaoPaulo(),
      uploaded_by: uploadedBy,
    });
  if (photoError) return photoError;

  const { error: linkError } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .insert({
      photo_id: request.photoId,
      meeting_id: request.meetingId,
      is_cover: false,
      is_sketch: false,
    });
  if (!linkError) return null;

  const { error: rollbackError } = await ctx.supabaseAdmin
    .from("photos")
    .delete()
    .eq("id", request.photoId);
  if (rollbackError) logError("rollback error", rollbackError.message);

  return linkError;
}

async function signedPhotoResponse(
  ctx: Ctx,
  req: Request,
  meetingId: string,
  id: string,
  url: string,
  status: number,
): Promise<Response> {
  const signed = await signMeetingPhotos(ctx, req, meetingId, [{ id, url }]);
  if (signed instanceof Response) return signed;
  if (signed.length === 0) return serverError();

  return Response.json({ photo: signed[0] }, { status });
}

function logError(label: string, message: string) {
  console.error(`add-meeting-photo ${label}`, message.replace(/[\r\n]/g, " "));
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function meetingIsFull(): Response {
  return Response.json({
    error:
      `meeting already has the maximum of ${MAX_PHOTOS_PER_MEETING} photos`,
  }, { status: 409 });
}

function serverError(): Response {
  return Response.json({ error: "Unable to add meeting photo" }, {
    status: 500,
  });
}
