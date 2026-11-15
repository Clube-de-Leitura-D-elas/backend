import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

const LOG_LABEL = "get-my-profile-summary";

type GroupRow = {
  id: string;
  number: number;
  photos: { url: string } | null;
};

type ReviewRow = {
  book_id: string;
  rating: number;
  books: { name: string; photos: { url: string } | null } | null;
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

  const [readCountResult, groupsResult, reviewsResult] = await Promise.all([
    ctx.supabaseAdmin
      .from("user_books")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profile.id)
      .eq("status", "READ"),
    ctx.supabaseAdmin
      .from("group_users")
      .select("groups!inner(id, number, photos(url))")
      .eq("user_id", profile.id)
      .eq("registration_status", "ACTIVE")
      .eq("groups.is_active", true),
    ctx.supabaseAdmin
      .from("book_reviews")
      .select("book_id, rating, evaluated_at, books!inner(name, photos(url))")
      .eq("user_id", profile.id)
      .order("evaluated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(10),
  ]);

  if (readCountResult.error) return dbError("read count", readCountResult.error);
  if (groupsResult.error) return dbError("groups", groupsResult.error);
  if (reviewsResult.error) return dbError("reviews", reviewsResult.error);

  const groupsById = new Map<string, GroupRow>();
  for (const row of groupsResult.data ?? []) {
    const group = (row as unknown as { groups: GroupRow }).groups;
    groupsById.set(group.id, group);
  }
  const groups = [...groupsById.values()].sort((left, right) =>
    left.number - right.number
  );
  const reviews = reviewsResult.data as unknown as ReviewRow[];
  const resolvePhotoUrl = await resolveProfilePhotoUrls(ctx, req, [
    ...groups.map((group) => group.photos?.url),
    ...reviews.map((review) => review.books?.photos?.url),
  ]);
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    books_read_count: readCountResult.count ?? 0,
    groups: groups.map((group) => ({
      id: group.id,
      number: group.number,
      photo_url: resolvePhotoUrl(group.photos?.url),
    })),
    reviewed_books: reviews.map((review) => ({
      book_id: review.book_id,
      title: review.books?.name ?? "",
      cover_url: resolvePhotoUrl(review.books?.photos?.url),
      rating: review.rating,
    })),
  });
}));

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to load profile summary" }, {
    status: 500,
  });
}
