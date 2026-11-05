import { oneLine } from "./log.ts";

const BOOKS_API_URL = "https://www.googleapis.com/books/v1";
const LANGUAGE = "pt";
const MAX_RESULTS = 10;
const TIMEOUT_MS = 5000;
const UNKNOWN_AUTHOR = "Autor desconhecido";

/** O que a busca devolve para o app escolher. */
export type BookSuggestion = {
  externalId: string;
  title: string;
  author: string;
  coverUrl: string | null;
};

/** Um volume já no formato da tabela `books`. */
export type GoogleBookDetails = {
  externalId: string;
  name: string;
  author: string;
  publisher: string;
  genre: string;
  synopsis: string | null;
  coverUrl: string | null;
};

export type GoogleBooksErrorCode =
  | "unavailable"
  | "quota_exceeded"
  | "invalid_key"
  | "not_found";

export type GoogleBooksError = { error: GoogleBooksErrorCode };

type GoogleVolume = {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    categories?: string[];
    description?: string;
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
};

/** Ids de volume do Google têm só letras, números, "_" e "-". */
export function isGoogleVolumeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function isGoogleBooksError(value: unknown): value is GoogleBooksError {
  return typeof value === "object" && value !== null && "error" in value;
}

async function callBooksApi(
  path: string,
  params: Record<string, string>,
  logLabel: string,
): Promise<unknown | GoogleBooksError> {
  const url = new URL(`${BOOKS_API_URL}${path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const headers: Record<string, string> = {};
  const key = Deno.env.get("GOOGLE_BOOKS_API_KEY");
  if (key) headers["X-Goog-Api-Key"] = key;

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(
      `${logLabel} google books request failed`,
      oneLine(String(error)),
    );
    return { error: "unavailable" };
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(
      `${logLabel} google books error ${response.status}`,
      oneLine(body),
    );
    return { error: errorCodeFor(response.status, body) };
  }

  try {
    return await response.json();
  } catch {
    console.error(`${logLabel} google books invalid json`);
    return { error: "unavailable" };
  }
}

function errorCodeFor(status: number, body: string): GoogleBooksErrorCode {
  if (
    status === 429 ||
    /dailyLimitExceeded|rateLimitExceeded|quotaExceeded/.test(body)
  ) {
    return "quota_exceeded";
  }
  if (/API_KEY_INVALID|keyInvalid|API key not valid/.test(body)) {
    return "invalid_key";
  }
  if (status === 404) return "not_found";
  return "unavailable";
}

/** Força https e tira o efeito de página dobrada (`edge=curl`) da capa. */
function toHttps(url: string | undefined): string | null {
  return url
    ? url.replace(/^http:\/\//i, "https://").replace("&edge=curl", "")
    : null;
}

/** A sinopse do Google vem com HTML (<p>, <br>, <b>): fica só o texto. */
function toPlainText(html: string | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

function mapVolume(volume: GoogleVolume): GoogleBookDetails | null {
  const info = volume.volumeInfo;
  const title = info?.title?.trim();
  if (!isGoogleVolumeId(volume.id) || !title) return null;

  const subtitle = info?.subtitle?.trim();
  const authors = (info?.authors ?? [])
    .map((author) => author.trim())
    .filter((author) => author.length > 0);

  return {
    externalId: volume.id,
    name: subtitle ? `${title}: ${subtitle}` : title,
    author: authors.length > 0 ? authors.join(", ") : UNKNOWN_AUTHOR,
    publisher: info?.publisher?.trim() ?? "",
    genre: info?.categories?.[0]?.trim() ?? "",
    synopsis: toPlainText(info?.description),
    coverUrl: toHttps(
      info?.imageLinks?.thumbnail ?? info?.imageLinks?.smallThumbnail,
    ),
  };
}

export async function searchGoogleBooks(
  query: string,
  logLabel: string,
): Promise<BookSuggestion[] | GoogleBooksError> {
  const result = await callBooksApi("/volumes", {
    q: query,
    langRestrict: LANGUAGE,
    printType: "books",
    maxResults: String(MAX_RESULTS),
  }, logLabel);
  if (isGoogleBooksError(result)) return result;

  const items = (result as { items?: GoogleVolume[] }).items ?? [];
  const seen = new Set<string>();

  return items.flatMap((volume) => {
    const book = mapVolume(volume);
    if (!book || seen.has(book.externalId)) return [];
    seen.add(book.externalId);
    return [{
      externalId: book.externalId,
      title: book.name,
      author: book.author,
      coverUrl: book.coverUrl,
    }];
  });
}

export async function getGoogleBook(
  volumeId: string,
  logLabel: string,
): Promise<GoogleBookDetails | GoogleBooksError> {
  if (!isGoogleVolumeId(volumeId)) return { error: "not_found" };

  const result = await callBooksApi(`/volumes/${volumeId}`, {}, logLabel);
  if (isGoogleBooksError(result)) return result;

  return mapVolume(result as GoogleVolume) ?? { error: "not_found" };
}
