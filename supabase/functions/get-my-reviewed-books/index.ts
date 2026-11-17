import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { parseListParams } from "../_shared/pagination.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

const LOG_LABEL = "get-my-reviewed-books";

type ReviewRow = {
  book_id: string;
  rating: number;
  commentary: string | null;
  evaluated_at: string;
  books: {
    name: string;
    author: string;
    photos: { url: string } | null;
  };
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
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

  const { from, to } = parseListParams(new URL(req.url));
  const { count, error: countError } = await ctx.supabaseAdmin
    .from("book_reviews")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id);

  if (countError) return dbError("review count", countError);

  const total = count ?? 0;
  if (from >= total) {
    return Response.json({ items: [], total });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("book_reviews")
    .select(
      "book_id, rating, commentary, evaluated_at, books!inner(name, author, photos(url))",
    )
    .eq("user_id", profile.id)
    .order("evaluated_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (error) return dbError("reviews", error);

  const reviews = (data ?? []) as unknown as ReviewRow[];
  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    reviews.map((review) => review.books.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    items: reviews.map((review) => ({
      book_id: review.book_id,
      title: review.books.name,
      author: review.books.author,
      cover_url: resolvePhotoUrl(review.books.photos?.url),
      rating: review.rating,
      commentary: review.commentary,
      evaluated_at: review.evaluated_at,
    })),
    total,
  });
}));

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to load reviewed books" }, {
    status: 500,
  });
}
