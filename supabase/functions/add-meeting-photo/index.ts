import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireGroupMemberProfile } from "../_shared/group.ts";
import { findMeetingGroupId } from "../_shared/meeting.ts";
import {
  MEETING_PHOTOS_BUCKET,
  signMeetingPhotos,
} from "../_shared/meetingPhoto.ts";
import { isUuid } from "../_shared/uuid.ts";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS_PER_MEETING = 50;
const MAX_BASE64_LENGTH = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;
const MAX_BODY_BYTES = MAX_BASE64_LENGTH + 4096;
const PHOTO_LIMIT_ERRCODE = "P0050";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

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

  const groupId = await findMeetingGroupId(
    ctx,
    request.meetingId,
    "add-meeting-photo",
  );
  if (groupId instanceof Response) return groupId;

  const member = await requireGroupMemberProfile(ctx, groupId, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

  const existing = await findExistingPhoto(ctx, request);
  if (existing) return existing;

  const full = await rejectWhenMeetingIsFull(ctx, request.meetingId);
  if (full) return full;

  const bytes = decodePhoto(request);
  if (bytes instanceof Response) return bytes;

  return await storePhoto(ctx, request, bytes, member.profileId);
}));

async function readPhotoRequest(req: Request): Promise<PhotoRequest | Response> {
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

  const link = data.meeting_photos as { meeting_id: string } | null;
  if (link?.meeting_id !== request.meetingId) {
    return Response.json({ error: '"photo_id" already in use' }, {
      status: 422,
    });
  }

  return await signedPhotoResponse(ctx, data.id, data.url, 200);
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

function decodePhoto(request: PhotoRequest): Uint8Array | Response {
  const bytes = decodeBase64(request.encoded);
  if (!bytes) return badRequest('invalid "data_base64"');
  if (bytes.byteLength > MAX_PHOTO_BYTES) return photoTooLarge();
  if (!matchesContentType(bytes, request.contentType)) {
    return badRequest('"data_base64" does not match "content_type"');
  }
  return bytes;
}

async function storePhoto(
  ctx: Ctx,
  request: PhotoRequest,
  bytes: Uint8Array,
  uploadedBy: string,
): Promise<Response> {
  const objectPath =
    `meetings/${request.meetingId}/${request.photoId}.${request.extension}`;
  const storage = ctx.supabaseAdmin.storage.from(MEETING_PHOTOS_BUCKET);

  const { error: uploadError } = await storage.upload(objectPath, bytes, {
    contentType: request.contentType,
    upsert: false,
  });
  if (uploadError) {
    logError("upload error", uploadError.message);
    return serverError();
  }

  const insertError = await insertPhotoRows(ctx, request, objectPath, uploadedBy);
  if (!insertError) {
    return await signedPhotoResponse(ctx, request.photoId, objectPath, 201);
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
  id: string,
  url: string,
  status: number,
): Promise<Response> {
  const signed = await signMeetingPhotos(ctx, [{ id, url }]);
  if (signed instanceof Response) return signed;
  if (signed.length === 0) return serverError();

  return Response.json({ photo: signed[0] }, { status });
}

function decodeBase64(encoded: string): Uint8Array | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function matchesContentType(bytes: Uint8Array, contentType: string): boolean {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));

  switch (contentType) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
      return ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12));
    default:
      return false;
  }
}

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" })
    .format(new Date());
}

function logError(label: string, message: string) {
  console.error(`add-meeting-photo ${label}`, message.replace(/[\r\n]/g, " "));
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function photoTooLarge(): Response {
  return Response.json({
    error: `photo exceeds the maximum of ${MAX_PHOTO_BYTES} bytes`,
  }, { status: 413 });
}

function meetingIsFull(): Response {
  return Response.json({
    error: `meeting already has the maximum of ${MAX_PHOTOS_PER_MEETING} photos`,
  }, { status: 409 });
}

function serverError(): Response {
  return Response.json({ error: "Unable to add meeting photo" }, {
    status: 500,
  });
}
