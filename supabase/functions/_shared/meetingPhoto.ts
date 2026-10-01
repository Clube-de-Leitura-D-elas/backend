import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

export const MEETING_PHOTOS_BUCKET = "meeting-photos";

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ABSOLUTE_URL_REGEX = /^https?:\/\//i;

export type MeetingPhoto = { id: string; url: string };

export async function signMeetingPhotos(
  ctx: SupabaseContext<Database>,
  photos: MeetingPhoto[],
): Promise<MeetingPhoto[] | Response> {
  const storagePaths = photos
    .map((photo) => photo.url)
    .filter((url) => !ABSOLUTE_URL_REGEX.test(url));

  if (storagePaths.length === 0) return photos;

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
      signedUrlByPath.set(item.path, item.signedUrl);
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
