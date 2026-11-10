import { oneLine } from "./log.ts";

const BOOKS_API_URL = "https://www.googleapis.com/books/v1";
const LANGUAGE = "pt";
const MAX_RESULTS = 10;
const TIMEOUT_MS = 5000;
const UNKNOWN_AUTHOR = "Autor desconhecido";
const REPLACEMENT_CHARACTER = "\uFFFD";

/** Entidades nomeadas mais comuns nas descrições do Google Books. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

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

  // A chave vai no cabeçalho, nunca na URL, para não aparecer em logs de erro.
  // Sem chave o Google usa um projeto anônimo com cota zero: a chamada volta
  // 429 e vira o erro tratado "quota_exceeded".
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
    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      console.error(
        `${logLabel} google books error body failed`,
        oneLine(String(error)),
      );
    }
    console.error(
      `${logLabel} google books error ${response.status}`,
      oneLine(body),
    );
    return { error: errorCodeFor(response.status, body) };
  }

  try {
    return await response.json();
  } catch (error) {
    console.error(
      `${logLabel} google books invalid response`,
      oneLine(String(error)),
    );
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

/**
 * Capa em https e sem o efeito de página dobrada (`edge`). Só aceita links
 * http(s): qualquer outro esquema (`data:`, `javascript:`...) vira sem capa.
 */
function toCoverUrl(url: string | undefined): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  parsed.protocol = "https:";
  parsed.searchParams.delete("edge");
  return parsed.toString();
}

/**
 * Como o parser HTML: 0, metades de par substituto (surrogates) e valores fora
 * do Unicode viram U+FFFD. O `\0` também quebraria o insert no Postgres.
 */
function fromCodePoint(code: number): string {
  const invalid = !Number.isSafeInteger(code) || code === 0 ||
    code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
  return invalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(code);
}

/**
 * Decodifica as entidades numa passada só, para um `&amp;lt;` virar o texto
 * `&lt;` e não `<`. Entidade nomeada desconhecida fica como veio.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (match, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return fromCodePoint(Number(decimal));
      if (hex !== undefined) return fromCodePoint(parseInt(hex, 16));
      return NAMED_ENTITIES[name!.toLowerCase()] ?? match;
    },
  );
}

/**
 * Tira caracteres de controle, que o Postgres recusa (`\0`) ou que não têm uso
 * em texto. Mantém só a quebra de linha e o tab.
 */
function stripControlCharacters(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      result += char;
    }
  }
  return result;
}

/** A sinopse do Google vem com HTML (<p>, <br>, <b>): fica só o texto. */
function toPlainText(html: string | undefined): string | null {
  if (!html) return null;

  const withoutTags = html
    .replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  const text = stripControlCharacters(
    decodeEntities(withoutTags).replace(/\r\n?/g, "\n"),
  )
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}

/** Texto aparado, ou `undefined` se o campo não for texto ou vier vazio. */
function cleanText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function mapVolume(volume: unknown): GoogleBookDetails | null {
  if (typeof volume !== "object" || volume === null) return null;
  const { id, volumeInfo: info } = volume as GoogleVolume;

  const title = cleanText(info?.title);
  if (!isGoogleVolumeId(id) || !title) return null;

  const subtitle = cleanText(info?.subtitle);
  const authors = (Array.isArray(info?.authors) ? info.authors : [])
    .map(cleanText)
    .filter((author): author is string => author !== undefined);
  const categories = Array.isArray(info?.categories) ? info.categories : [];

  return {
    externalId: id,
    name: subtitle ? `${title}: ${subtitle}` : title,
    author: authors.length > 0 ? authors.join(", ") : UNKNOWN_AUTHOR,
    publisher: cleanText(info?.publisher) ?? "",
    genre: cleanText(categories[0]) ?? "",
    synopsis: toPlainText(cleanText(info?.description)),
    coverUrl: toCoverUrl(
      cleanText(info?.imageLinks?.thumbnail) ??
        cleanText(info?.imageLinks?.smallThumbnail),
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

  const items = (result as { items?: unknown } | null)?.items;
  const seen = new Set<string>();

  if (!Array.isArray(items)) return [];

  return items.flatMap((volume: unknown) => {
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

  return mapVolume(result) ?? { error: "not_found" };
}
