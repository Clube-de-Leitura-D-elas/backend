// Validação das fotos enviadas em base64 pelo app (add-meeting-photo,
// set-profile-photo).

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_BASE64_LENGTH = Math.ceil(MAX_PHOTO_BYTES / 3) * 4;
export const MAX_BODY_BYTES = MAX_BASE64_LENGTH + 4096;

export const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

export function decodePhoto(
  encoded: string,
  contentType: string,
  fields: { encoded: string; contentType: string },
): Uint8Array | Response {
  const bytes = decodeBase64(encoded);
  if (!bytes) {
    return Response.json({ error: `invalid "${fields.encoded}"` }, {
      status: 400,
    });
  }
  if (bytes.byteLength > MAX_PHOTO_BYTES) return photoTooLarge();
  if (!matchesContentType(bytes, contentType)) {
    return Response.json({
      error: `"${fields.encoded}" does not match "${fields.contentType}"`,
    }, { status: 400 });
  }
  return bytes;
}

export function photoTooLarge(): Response {
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
      return bytes[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/heic":
      return ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12));
    default:
      return false;
  }
}
