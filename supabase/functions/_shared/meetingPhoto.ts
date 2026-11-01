import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { SIGNED_URL_TTL_SECONDS, toPublicUrl } from "./signedUrl.ts";

export const MEETING_PHOTOS_BUCKET = "meeting-photos";

const ABSOLUTE_URL_REGEX = /^https?:\/\//i;

export type MeetingPhoto = {
  id: string;
  url: string;
  caption?: string | null;
};

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
    return [{ ...photo, url: signedUrl }];
  });
}
