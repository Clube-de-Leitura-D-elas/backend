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

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

type AddMeetingPhotoBody = {
  meeting_id?: unknown;
  content_type?: unknown;
  data_base64?: unknown;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: AddMeetingPhotoBody | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const meetingId = body?.meeting_id;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }

  const contentType = body?.content_type;
  const extension = typeof contentType === "string"
    ? EXTENSION_BY_CONTENT_TYPE[contentType]
    : undefined;
  if (!extension) {
    return Response.json({
      error: 'missing/invalid "content_type" (expected one of: ' +
        Object.keys(EXTENSION_BY_CONTENT_TYPE).join(", ") + ")",
    }, { status: 400 });
  }

  const encoded = body?.data_base64;
  if (typeof encoded !== "string" || encoded.length === 0) {
    return Response.json({ error: 'missing/invalid "data_base64"' }, {
      status: 400,
    });
  }
  if (encoded.length > MAX_BASE64_LENGTH) {
    return photoTooLarge();
  }

  const bytes = decodeBase64(encoded);
  if (!bytes) {
    return Response.json({ error: 'invalid "data_base64"' }, { status: 400 });
  }
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return photoTooLarge();
  }
  if (!matchesContentType(bytes, contentType as string)) {
    return Response.json({ error: '"data_base64" does not match "content_type"' }, {
      status: 400,
    });
  }

  const groupId = await findMeetingGroupId(ctx, meetingId, "add-meeting-photo");
  if (groupId instanceof Response) return groupId;

  const member = await requireGroupMemberProfile(ctx, groupId);
  if (member instanceof Response) return member;

  const { count, error: countError } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .select("photo_id", { count: "exact", head: true })
    .eq("meeting_id", meetingId);

  if (countError) {
    console.error(
      "add-meeting-photo count error",
      countError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to add meeting photo" }, {
      status: 500,
    });
  }
  if ((count ?? 0) >= MAX_PHOTOS_PER_MEETING) {
    return Response.json({
      error: `meeting already has the maximum of ${MAX_PHOTOS_PER_MEETING} photos`,
    }, { status: 409 });
  }

  const photoId = crypto.randomUUID();
  const objectPath = `meetings/${meetingId}/${photoId}.${extension}`;
  const storage = ctx.supabaseAdmin.storage.from(MEETING_PHOTOS_BUCKET);

  const { error: uploadError } = await storage.upload(objectPath, bytes, {
    contentType: contentType as string,
    upsert: false,
  });
  if (uploadError) {
    console.error(
      "add-meeting-photo upload error",
      uploadError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to add meeting photo" }, {
      status: 500,
    });
  }

  const insertError = await insertPhotoRows(ctx, {
    photoId,
    meetingId,
    objectPath,
    extension,
    uploadedBy: member.profileId,
  });
  if (insertError) {
    console.error(
      "add-meeting-photo insert error",
      insertError.replace(/[\r\n]/g, " "),
    );
    const { error: removeError } = await storage.remove([objectPath]);
    if (removeError) {
      console.error(
        "add-meeting-photo cleanup error",
        removeError.message.replace(/[\r\n]/g, " "),
      );
    }
    return Response.json({ error: "Unable to add meeting photo" }, {
      status: 500,
    });
  }

  const signed = await signMeetingPhotos(ctx, [{ id: photoId, url: objectPath }]);
  if (signed instanceof Response) return signed;

  return Response.json({ photo: signed[0] ?? null }, { status: 201 });
}));

function photoTooLarge(): Response {
  return Response.json({
    error: `photo exceeds the maximum of ${MAX_PHOTO_BYTES} bytes`,
  }, { status: 413 });
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
      return ascii(1, 4) === "PNG" && bytes[0] === 0x89;
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
      return ascii(4, 8) === "ftyp";
    default:
      return false;
  }
}

async function insertPhotoRows(
  ctx: SupabaseContext<Database>,
  row: {
    photoId: string;
    meetingId: string;
    objectPath: string;
    extension: string;
    uploadedBy: string;
  },
): Promise<string | null> {
  const { error: photoError } = await ctx.supabaseAdmin
    .from("photos")
    .insert({
      id: row.photoId,
      url: row.objectPath,
      file_extension: row.extension,
      uploaded_at: new Date().toISOString().slice(0, 10),
      uploaded_by: row.uploadedBy,
    });
  if (photoError) return photoError.message;

  const { error: linkError } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .insert({
      photo_id: row.photoId,
      meeting_id: row.meetingId,
      is_cover: false,
    });
  if (!linkError) return null;

  await ctx.supabaseAdmin.from("photos").delete().eq("id", row.photoId);
  return linkError.message;
}
