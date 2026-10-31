export const SIGNED_URL_TTL_SECONDS = 60 * 60;

// The local edge runtime signs with its internal gateway host (kong:8000),
// which devices cannot reach; rewrite it to the origin the client called.
export function toPublicUrl(signedUrl: string, req: Request): string {
  const url = new URL(signedUrl);
  if (url.hostname !== "kong") return signedUrl;

  const host = req.headers.get("x-forwarded-host");
  if (!host) return signedUrl;

  url.protocol = req.headers.get("x-forwarded-proto") ?? url.protocol;
  const port = req.headers.get("x-forwarded-port");
  url.host = host.includes(":") || !port ? host : `${host}:${port}`;
  return url.toString();
}
