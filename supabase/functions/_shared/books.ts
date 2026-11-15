import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { todayInSaoPaulo } from "./date.ts";
import {
  getGoogleBook,
  type GoogleBooksErrorCode,
  isGoogleBooksError,
  isGoogleVolumeId,
} from "./googleBooks.ts";
import { oneLine } from "./log.ts";

type Ctx = SupabaseContext<Database>;

const STATUS_BY_ERROR: Record<GoogleBooksErrorCode, number> = {
  not_found: 404,
  quota_exceeded: 503,
  unavailable: 503,
  invalid_key: 503,
};

async function findBookId(
  ctx: Ctx,
  externalId: string,
  logLabel: string,
): Promise<string | null | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("books")
    .select("id")
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) return dbError(logLabel, "book lookup", error.message);
  return data?.id ?? null;
}

async function insertCover(
  ctx: Ctx,
  coverUrl: string,
  uploadedBy: string,
  logLabel: string,
): Promise<string | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("photos")
    .insert({
      url: coverUrl,
      file_extension: "jpg",
      uploaded_at: todayInSaoPaulo(),
      uploaded_by: uploadedBy,
    })
    .select("id")
    .single();

  if (error) return dbError(logLabel, "cover", error.message);
  return data.id;
}

function dbError(logLabel: string, label: string, message: string): Response {
  console.error(`${logLabel} ${label} error`, oneLine(message));
  return Response.json({ error: "Unable to save book" }, { status: 500 });
}

/**
 * Devolve o id em `books` de um volume do Google. Se o livro já foi salvo,
 * não chama o Google; senão busca os detalhes, salva a capa e o livro.
 */
export async function findOrCreateBook(
  ctx: Ctx,
  externalId: string,
  uploadedBy: string,
  logLabel: string,
): Promise<string | Response> {
  if (!isGoogleVolumeId(externalId)) {
    return Response.json({ error: "invalid_external_id" }, { status: 400 });
  }

  const existing = await findBookId(ctx, externalId, logLabel);
  if (existing !== null) return existing;

  const book = await getGoogleBook(externalId, logLabel);
  if (isGoogleBooksError(book)) {
    return Response.json({ error: `google_books_${book.error}` }, {
      status: STATUS_BY_ERROR[book.error],
    });
  }

  let photoId: string | null = null;
  if (book.coverUrl) {
    const cover = await insertCover(ctx, book.coverUrl, uploadedBy, logLabel);
    if (cover instanceof Response) return cover;
    photoId = cover;
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("books")
    .upsert({
      external_id: externalId,
      name: book.name,
      author: book.author,
      publisher: book.publisher,
      genre: book.genre,
      synopsis: book.synopsis,
      photo_id: photoId,
    }, { onConflict: "external_id", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();

  if (error) {
    await removeCover(ctx, photoId, logLabel);
    return dbError(logLabel, "book insert", error.message);
  }
  if (data) return data.id;

  // Outra pessoa salvou o mesmo livro ao mesmo tempo: usa o que ela salvou.
  await removeCover(ctx, photoId, logLabel);
  const saved = await findBookId(ctx, externalId, logLabel);
  return saved ?? dbError(logLabel, "book lookup", "missing after conflict");
}

async function removeCover(
  ctx: Ctx,
  photoId: string | null,
  logLabel: string,
): Promise<void> {
  if (!photoId) return;
  const { error } = await ctx.supabaseAdmin
    .from("photos")
    .delete()
    .eq("id", photoId);
  if (error) {
    console.error(`${logLabel} cover cleanup error`, oneLine(error.message));
  }
}
