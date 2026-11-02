import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "recommend-book";
const ALREADY_RECOMMENDED = "already_recommended";
const UNIQUE_VIOLATION = "23505";
const RECOMMENDATION_CONSTRAINT =
  "book_suggestions_group_id_book_id_key";

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
  const groupId = body?.group_id;
  if (!isUuid(groupId)) {
    return Response.json({ error: "invalid_group_id" }, { status: 400 });
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

  const { data: book, error: bookError } = await ctx.supabaseAdmin
    .from("books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle();
  if (bookError) return dbError("book", bookError);
  if (!book) {
    return Response.json({ error: "book_not_found" }, { status: 404 });
  }

  const { data: membership, error: membershipError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id, groups!inner(id)")
    .eq("group_id", groupId)
    .eq("user_id", profile.id)
    .eq("registration_status", "ACTIVE")
    .eq("groups.is_active", true)
    .limit(1)
    .maybeSingle();
  if (membershipError) return dbError("membership", membershipError);
  if (!membership) {
    return Response.json({ error: "not_group_member" }, { status: 403 });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("book_suggestions")
    .insert({
      book_id: book.id,
      group_id: groupId,
      group_user_id: membership.id,
      suggested_at: new Date().toISOString(),
      book_status: "AVAILABLE",
    })
    .select("id, book_id, group_id, suggested_at")
    .single();
  if (error) {
    const constraint = `${error.message} ${error.details ?? ""}`;
    if (
      error.code === UNIQUE_VIOLATION &&
      constraint.includes(RECOMMENDATION_CONSTRAINT)
    ) {
      return Response.json({ error: ALREADY_RECOMMENDED }, { status: 409 });
    }
    return dbError("recommendation", error);
  }

  const recommendation = data as {
    id: string;
    book_id: string;
    group_id: string;
    suggested_at: string;
  };
  return Response.json(recommendation, { status: 201 });
}));

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to recommend book" }, { status: 500 });
}
