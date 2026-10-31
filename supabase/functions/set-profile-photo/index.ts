import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { todayInSaoPaulo } from "../_shared/date.ts";
import {
  decodePhoto,
  EXTENSION_BY_CONTENT_TYPE,
  MAX_BASE64_LENGTH,
  MAX_BODY_BYTES,
  photoTooLarge,
} from "../_shared/photoUpload.ts";
import {
  PROFILE_PHOTOS_BUCKET,
  profilePhotoFolder,
  resolveProfilePhotoUrls,
} from "../_shared/profilePhoto.ts";

type Ctx = SupabaseContext<Database>;

type PhotoRequest = {
  contentType: string;
  extension: string;
  encoded: string;
};

type ProfileRow = {
  id: string;
  photo_id: string | null;
  photos: { url: string } | null;
};

// Troca a foto de perfil da leitora autenticada e apaga a anterior (registro
// em photos e objeto no storage), que não é referenciada em mais nenhum lugar.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const request = await readPhotoRequest(req);
  if (request instanceof Response) return request;

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profileData, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id, photo_id, photos(url)")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    logError("profile error", profileError.message);
    return serverError();
  }
  if (!profileData) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }
  const profile = profileData as unknown as ProfileRow;

  const bytes = decodePhoto(request.encoded, request.contentType, {
    encoded: "encoded",
    contentType: "contentType",
  });
  if (bytes instanceof Response) return bytes;

  const photoId = crypto.randomUUID();
  const folder = profilePhotoFolder(profile.id);
  const objectPath = `${folder}${photoId}.${request.extension}`;
  const storage = ctx.supabaseAdmin.storage.from(PROFILE_PHOTOS_BUCKET);

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

  await removePreviousPhoto(ctx, profile);

  const resolvePhotoUrl = await resolveProfilePhotoUrls(ctx, req, [
    objectPath,
  ]);
  if (resolvePhotoUrl instanceof Response) return serverError();

  const photoUrl = resolvePhotoUrl(objectPath);
  if (!photoUrl) return serverError();

  return Response.json({ photo_url: photoUrl });
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

// Só apaga a foto que esta função enviou para a própria leitora; uma URL
// absoluta (seed) ou de outra pasta fica intacta. Falha aqui não desfaz a troca.
async function removePreviousPhoto(ctx: Ctx, profile: ProfileRow) {
  const url = profile.photos?.url;
  if (!profile.photo_id || !url?.startsWith(profilePhotoFolder(profile.id))) {
    return;
  }

  const { error: deleteError } = await ctx.supabaseAdmin
    .from("photos")
    .delete()
    .eq("id", profile.photo_id);
  if (deleteError) {
    logError("previous photo delete error", deleteError.message);
    return;
  }

  const { error: removeError } = await ctx.supabaseAdmin.storage
    .from(PROFILE_PHOTOS_BUCKET)
    .remove([url]);
  if (removeError) {
    logError("previous photo remove error", removeError.message);
  }
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
