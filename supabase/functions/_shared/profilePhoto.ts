import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { oneLine } from "./log.ts";
import { SIGNED_URL_TTL_SECONDS, toPublicUrl } from "./signedUrl.ts";

export const PROFILE_PHOTOS_BUCKET = "profile-photos";

const PROFILE_PHOTO_PREFIX = "profiles/";

export type PhotoUrlResolver = (
  url: string | null | undefined,
) => string | null;

/** Pasta das fotos de perfil de uma usuária no bucket (`photos.url`). */
export function profilePhotoFolder(userId: string): string {
  return `${PROFILE_PHOTO_PREFIX}${userId}/`;
}

/**
 * Converte o `photos.url` das fotos de perfil em URLs que o app abre.
 * Caminho `profiles/...` do bucket privado vira signed URL; qualquer outro
 * valor (ex.: URL absoluta do seed) passa como antes. Assina todas de uma vez
 * e devolve uma função para usar no map.
 * Retorna uma Response de erro para devolver direto se a assinatura falhar.
 */
export async function resolveProfilePhotoUrls(
  ctx: SupabaseContext<Database>,
  req: Request,
  urls: (string | null | undefined)[],
): Promise<PhotoUrlResolver | Response> {
  const paths = [
    ...new Set(
      urls.filter((url): url is string =>
        !!url && url.startsWith(PROFILE_PHOTO_PREFIX)
      ),
    ),
  ];

  const signedUrlByPath = new Map<string, string>();
  if (paths.length > 0) {
    const { data, error } = await ctx.supabaseAdmin.storage
      .from(PROFILE_PHOTOS_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

    if (error) {
      console.error("profile photos sign error", oneLine(error.message));
      return Response.json({ error: "Unable to load profile photos" }, {
        status: 500,
      });
    }

    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        signedUrlByPath.set(item.path, toPublicUrl(item.signedUrl, req));
      }
    }
  }

  return (url) => {
    if (!url) return null;
    if (!url.startsWith(PROFILE_PHOTO_PREFIX)) return url;
    const signedUrl = signedUrlByPath.get(url);
    if (!signedUrl) console.warn("profile photo without signed url", url);
    return signedUrl ?? null;
  };
}
