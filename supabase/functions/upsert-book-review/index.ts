import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "upsert-book-review";
const MAX_COMMENTARY_LENGTH = 1000;

type ReviewResult = {
  id: string;
  rating: number;
  commentary: string | null;
  evaluated_at: string;
  rating_average: number | null;
  ratings_count: number;
};

// Grava ou substitui a avaliação da leitora autenticada e marca o livro como
// READ na estante, numa transação só (`upsert_book_review`). Devolve a nova
// média e contagem para o header da tela atualizar sem outra chamada.
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

  const rating = body?.rating;
  if (
    typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 ||
    rating > 5
  ) {
    return Response.json({ error: "invalid_rating" }, { status: 400 });
  }

  // O Postgres recusa NUL e surrogate solto em texto: sem isso viraria 500.
  const rawCommentary = body?.commentary ?? null;
  if (
    rawCommentary !== null &&
    (typeof rawCommentary !== "string" || !rawCommentary.isWellFormed() ||
      rawCommentary.includes("\0"))
  ) {
    return Response.json({ error: "invalid_commentary" }, { status: 400 });
  }
  const commentary = rawCommentary?.trim() || null;
  // Conta caracteres como o Postgres, não unidades UTF-16 (emoji conta 1).
  if (commentary && [...commentary].length > MAX_COMMENTARY_LENGTH) {
    return Response.json({ error: "commentary_too_long" }, { status: 400 });
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

  const { data, error } = await ctx.supabaseAdmin
    .rpc("upsert_book_review", {
      p_user_id: profile.id,
      p_book_id: book.id,
      p_rating: rating,
      p_commentary: commentary,
    })
    .single();

  if (error) return serverError("upsert", error);
  const review = data as ReviewResult;

  return Response.json({
    id: review.id,
    rating: review.rating,
    commentary: review.commentary,
    evaluated_at: review.evaluated_at,
    rating_average: roundToHalf(review.rating_average),
    ratings_count: review.ratings_count,
    my_status: "READ",
  });
}));

// Mesmo arredondamento do get-book-details: meia estrela mais próxima.
function roundToHalf(average: number | null): number | null {
  return average === null ? null : Math.round(average * 2) / 2;
}

function serverError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to save book review" }, {
    status: 500,
  });
}
