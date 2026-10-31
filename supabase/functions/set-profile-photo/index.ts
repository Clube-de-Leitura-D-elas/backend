import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { todayInSaoPaulo } from "../_shared/date.ts";
import {
  MEETING_PHOTOS_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  toPublicUrl,
} from "../_shared/meetingPhoto.ts";
import {
  decodePhoto,
  EXTENSION_BY_CONTENT_TYPE,
  MAX_BASE64_LENGTH,
  MAX_BODY_BYTES,
  photoTooLarge,
} from "../_shared/photoUpload.ts";

type Ctx = SupabaseContext<Database>;

type PhotoRequest = {
  contentType: string;
  extension: string;
  encoded: string;
};

// Troca a foto de perfil da leitora autenticada. A foto anterior fica órfã:
// o registro em photos e o objeto no storage não são apagados.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const request = await readPhotoRequest(req);
  if (request instanceof Response) return request;

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    logError("profile error", profileError.message);
    return serverError();
  }
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const bytes = decodePhoto(request.encoded, request.contentType, {
    encoded: "encoded",
    contentType: "contentType",
  });
  if (bytes instanceof Response) return bytes;

  const photoId = crypto.randomUUID();
  const objectPath = `profiles/${profile.id}/${photoId}.${request.extension}`;
  const storage = ctx.supabaseAdmin.storage.from(MEETING_PHOTOS_BUCKET);

  const { error: uploadError } = await storage.upload(objectPath, bytes, {
    contentType: request.contentType,
  });
  if (uploadError) {
    logError("upload error", uploadError.message);
    return serverError();
  }

  const saveError = await savePhoto(
    ctx,
    profile.id,
    photoId,
    objectPath,
    request,
  );
  if (saveError) {
    logError("save error", saveError.message);
    const { error: removeError } = await storage.remove([objectPath]);
    if (removeError) logError("cleanup error", removeError.message);
    return serverError();
  }

  const { data: signed, error: signError } = await storage.createSignedUrl(
    objectPath,
    SIGNED_URL_TTL_SECONDS,
  );
  if (signError || !signed?.signedUrl) {
    logError("sign error", signError?.message ?? "missing signed url");
    return serverError();
  }

  return Response.json({ photo_url: toPublicUrl(signed.signedUrl, req) });
}));

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

  const contentType = body?.contentType;
  const extension = typeof contentType === "string"
    ? EXTENSION_BY_CONTENT_TYPE[contentType]
    : undefined;
  if (!extension) {
    return badRequest(
      'missing/invalid "contentType" (expected one of: ' +
        Object.keys(EXTENSION_BY_CONTENT_TYPE).join(", ") + ")",
    );
  }

  if (body?.extension !== extension) {
    return badRequest(`missing/invalid "extension" (expected "${extension}")`);
  }

  const encoded = body?.encoded;
  if (typeof encoded !== "string" || encoded.length === 0) {
    return badRequest('missing/invalid "encoded"');
  }
  if (encoded.length > MAX_BASE64_LENGTH) {
    return photoTooLarge();
  }

  return { contentType: contentType as string, extension, encoded };
}

async function savePhoto(
  ctx: Ctx,
  profileId: string,
  photoId: string,
  objectPath: string,
  request: PhotoRequest,
): Promise<{ message: string } | null> {
  const { error: photoError } = await ctx.supabaseAdmin
    .from("photos")
    .insert({
      id: photoId,
      url: objectPath,
      file_extension: request.extension,
      uploaded_at: todayInSaoPaulo(),
      uploaded_by: profileId,
    });
  if (photoError) return photoError;

  const { error: userError } = await ctx.supabaseAdmin
    .from("users")
    .update({ photo_id: photoId })
    .eq("id", profileId);
  if (!userError) return null;

  const { error: rollbackError } = await ctx.supabaseAdmin
    .from("photos")
    .delete()
    .eq("id", photoId);
  if (rollbackError) logError("rollback error", rollbackError.message);

  return userError;
}

function logError(label: string, message: string) {
  console.error(`set-profile-photo ${label}`, message.replace(/[\r\n]/g, " "));
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(): Response {
  return Response.json({ error: "Unable to set profile photo" }, {
    status: 500,
  });
}
