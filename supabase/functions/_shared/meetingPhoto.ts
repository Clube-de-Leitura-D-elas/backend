import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

export const MEETING_PHOTOS_BUCKET = "meeting-photos";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ABSOLUTE_URL_REGEX = /^https?:\/\//i;

export type MeetingPhoto = { id: string; url: string };

export async function signMeetingPhotos(
  ctx: SupabaseContext<Database>,
  req: Request,
  meetingId: string,
  photos: MeetingPhoto[],
): Promise<MeetingPhoto[] | Response> {
  const meetingPrefix = `meetings/${meetingId}/`;
  const storagePaths = photos
    .map((photo) => photo.url)
    .filter((url) =>
      !ABSOLUTE_URL_REGEX.test(url) && url.startsWith(meetingPrefix)
    );

  if (storagePaths.length === 0) {
    return photos.filter((photo) => ABSOLUTE_URL_REGEX.test(photo.url));
  }

  const { data, error } = await ctx.supabaseAdmin.storage
    .from(MEETING_PHOTOS_BUCKET)
    .createSignedUrls(storagePaths, SIGNED_URL_TTL_SECONDS);

  if (error) {
    console.error(
      "meeting photos sign error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to load meeting photos" }, {
      status: 500,
    });
  }

  const signedUrlByPath = new Map<string, string>();
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) {
      signedUrlByPath.set(item.path, toPublicUrl(item.signedUrl, req));
    }
  }

  return photos.flatMap((photo) => {
    if (ABSOLUTE_URL_REGEX.test(photo.url)) return [photo];
    const signedUrl = signedUrlByPath.get(photo.url);
    if (!signedUrl) {
      console.warn("meeting photo without signed url", photo.id);
      return [];
    }
    return [{ id: photo.id, url: signedUrl }];
  });
}

// The local edge runtime signs with its internal gateway host (kong:8000),
// which devices cannot reach; rewrite it to the origin the client called.
function toPublicUrl(signedUrl: string, req: Request): string {
  const url = new URL(signedUrl);
  if (url.hostname !== "kong") return signedUrl;

  const host = req.headers.get("x-forwarded-host");
  if (!host) return signedUrl;

  url.protocol = req.headers.get("x-forwarded-proto") ?? url.protocol;
  const port = req.headers.get("x-forwarded-port");
  url.host = host.includes(":") || !port ? host : `${host}:${port}`;
  return url.toString();
}
