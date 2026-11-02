import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "set-book-reading-status";
const READING_STATUSES: readonly string[] = ["WANT_TO_READ", "READ"];

type ReadingStatus = "WANT_TO_READ" | "READ";

const isReadingStatus = (value: unknown): value is ReadingStatus =>
  typeof value === "string" && READING_STATUSES.includes(value);

// Marca o livro na estante da leitora autenticada. `status: null` desmarca
// (remove a linha de user_books). Não mexe em avaliações.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  const bookId = body?.book_id;
  if (!isUuid(bookId)) {
    return Response.json({ error: "invalid_book_id" }, { status: 400 });
  }

  // A chave precisa vir no body: ausente não é o mesmo que `null` (desmarcar).
  const status = body?.status;
  if (status === undefined || (status !== null && !isReadingStatus(status))) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) return serverError("profile", profileError);
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: book, error: bookError } = await ctx.supabaseAdmin
    .from("books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle();

  if (bookError) return serverError("book", bookError);
  if (!book) {
    return Response.json({ error: "book_not_found" }, { status: 404 });
  }

  if (status === null) {
    const { error: deleteError } = await ctx.supabaseAdmin
      .from("user_books")
      .delete()
      .eq("user_id", profile.id)
      .eq("book_id", book.id);

    if (deleteError) return serverError("delete", deleteError);
    return Response.json({ book_id: book.id, status: null });
  }

  // updated_at não tem trigger: a function grava a data a cada mudança.
  const { error: upsertError } = await ctx.supabaseAdmin
    .from("user_books")
    .upsert(
      {
        user_id: profile.id,
        book_id: book.id,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,book_id" },
    );

  if (upsertError) return serverError("upsert", upsertError);
  return Response.json({ book_id: book.id, status });
}));

function serverError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to set reading status" }, {
    status: 500,
  });
}
