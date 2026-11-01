import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { toPositiveInt } from "../_shared/pagination.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "get-book-details";
const DEFAULT_REVIEWS_PAGE_SIZE = 10;
const MAX_REVIEWS_PAGE_SIZE = 50;
// Mesmo limite do max_rows do PostgREST (config.toml).
const RATINGS_BATCH_SIZE = 1000;

type Ctx = SupabaseContext<Database>;

type BookRow = {
  id: string;
  name: string;
  author: string;
  genre: string;
  publisher: string;
  synopsis: string | null;
  photos: { url: string } | null;
};

type MyReviewRow = {
  rating: number;
  commentary: string | null;
  evaluated_at: string;
};

type ReviewRow = MyReviewRow & {
  id: string;
  users: { id: string; name: string; photos: { url: string } | null };
};

// Tudo que a tela de detalhes do livro precisa: dados e sinopse, média das
// avaliações, estado da leitora (estante e avaliação dela) e as avaliações das
// outras leitoras, paginadas. Query string: bookId, reviewsPage, reviewsPageSize.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const url = new URL(req.url);
  const bookId = url.searchParams.get("bookId");
  if (!isUuid(bookId)) {
    return Response.json({ error: "invalid_book_id" }, { status: 400 });
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

  if (profileError) return dbError("profile", profileError);
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data: bookData, error: bookError } = await ctx.supabaseAdmin
    .from("books")
    .select("id, name, author, genre, publisher, synopsis, photos(url)")
    .eq("id", bookId)
    .maybeSingle();

  if (bookError) return dbError("book", bookError);
  if (!bookData) {
    return Response.json({ error: "book_not_found" }, { status: 404 });
  }
  const book = bookData as unknown as BookRow;

  const page = toPositiveInt(url.searchParams.get("reviewsPage"), 1);
  const pageSize = Math.min(
    toPositiveInt(
      url.searchParams.get("reviewsPageSize"),
      DEFAULT_REVIEWS_PAGE_SIZE,
    ),
    MAX_REVIEWS_PAGE_SIZE,
  );
  const from = (page - 1) * pageSize;

  const [ratings, statusResult, myReviewResult, reviewsResult] = await Promise
    .all([
      loadRatings(ctx, bookId),
      ctx.supabaseAdmin
        .from("user_books")
        .select("status")
        .eq("user_id", profile.id)
        .eq("book_id", bookId)
        .maybeSingle(),
      ctx.supabaseAdmin
        .from("book_reviews")
        .select("rating, commentary, evaluated_at")
        .eq("user_id", profile.id)
        .eq("book_id", bookId)
        .maybeSingle(),
      // Uma linha a mais que a página indica se existe a próxima.
      ctx.supabaseAdmin
        .from("book_reviews")
        .select(
          "id, rating, commentary, evaluated_at, users!inner(id, name, photos(url))",
        )
        .eq("book_id", bookId)
        .neq("user_id", profile.id)
        .order("evaluated_at", { ascending: false })
        .order("id")
        .range(from, from + pageSize),
    ]);

  if (ratings instanceof Response) return ratings;
  if (statusResult.error) return dbError("status", statusResult.error);
  if (myReviewResult.error) return dbError("my review", myReviewResult.error);
  if (reviewsResult.error) return dbError("reviews", reviewsResult.error);

  const reviewRows = (reviewsResult.data ?? []) as unknown as ReviewRow[];
  const pageRows = reviewRows.slice(0, pageSize);
  const myReview = myReviewResult.data as MyReviewRow | null;

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    pageRows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    id: book.id,
    title: book.name,
    author: book.author,
    genre: book.genre,
    publisher: book.publisher,
    synopsis: book.synopsis,
    cover_url: book.photos?.url ?? null,
    rating_average: roundToHalf(ratings),
    ratings_count: ratings.length,
    my_status: statusResult.data?.status ?? null,
    my_review: myReview
      ? {
        rating: myReview.rating,
        commentary: myReview.commentary,
        evaluated_at: myReview.evaluated_at,
      }
      : null,
    reviews: {
      items: pageRows.map((row) => ({
        id: row.id,
        user: {
          id: row.users.id,
          name: row.users.name,
          photo_url: resolvePhotoUrl(row.users.photos?.url),
        },
        rating: row.rating,
        commentary: row.commentary,
        evaluated_at: row.evaluated_at,
      })),
      has_more: reviewRows.length > pageSize,
    },
  });
}));

// Todas as notas do livro, em lotes: uma consulta só pararia no max_rows.
async function loadRatings(
  ctx: Ctx,
  bookId: string,
): Promise<number[] | Response> {
  const ratings: number[] = [];
  for (let offset = 0;; offset += RATINGS_BATCH_SIZE) {
    const { data, error } = await ctx.supabaseAdmin
      .from("book_reviews")
      .select("rating")
      .eq("book_id", bookId)
      .order("id")
      .range(offset, offset + RATINGS_BATCH_SIZE - 1);

    if (error) return dbError("ratings", error);

    const batch = (data ?? []) as { rating: number }[];
    ratings.push(...batch.map((row) => row.rating));
    if (batch.length < RATINGS_BATCH_SIZE) return ratings;
  }
}

// Média arredondada à meia estrela mais próxima; null sem avaliações.
function roundToHalf(ratings: number[]): number | null {
  if (ratings.length === 0) return null;
  const average = ratings.reduce((sum, rating) => sum + rating, 0) /
    ratings.length;
  return Math.round(average * 2) / 2;
}

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to load book details" }, {
    status: 500,
  });
}
