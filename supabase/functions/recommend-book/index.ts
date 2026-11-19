import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "recommend-book";
const ALREADY_RECOMMENDED = "already_recommended";
const NOT_GROUP_MEMBER_CODE = "P0043";
const HOST_NOT_ELIGIBLE_CODE = "P0052";
const BOOK_NOT_FOUND_CODE = "P0002";
const UNIQUE_VIOLATION = "23505";

type RecommendationRow = {
  id: string;
  book_id: string;
  group_id: string;
  suggested_at: string;
  action: "created" | "replaced";
};

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

  const { data, error } = await ctx.supabaseAdmin
    .rpc("recommend_book", {
      p_group_id: groupId,
      p_user_id: profile.id,
      p_book_id: bookId,
    })
    .single();
  if (error) {
    if (error.code === NOT_GROUP_MEMBER_CODE) {
      return Response.json({ error: "not_group_member" }, { status: 403 });
    }
    if (error.code === HOST_NOT_ELIGIBLE_CODE) {
      return Response.json({ error: "host_not_eligible" }, { status: 403 });
    }
    if (error.code === BOOK_NOT_FOUND_CODE) {
      return Response.json({ error: "book_not_found" }, { status: 404 });
    }
    if (error.code === UNIQUE_VIOLATION) {
      return Response.json({ error: ALREADY_RECOMMENDED }, { status: 409 });
    }
    return dbError("recommendation", error);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | RecommendationRow
    | null;
  if (!row) {
    return dbError("recommendation", {
      message: "empty recommend_book result",
    });
  }

  const replaced = row.action === "replaced";
  return Response.json(
    {
      id: row.id,
      book_id: row.book_id,
      group_id: row.group_id,
      suggested_at: row.suggested_at,
      replaced,
    },
    { status: replaced ? 200 : 201 },
  );
}));

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to recommend book" }, { status: 500 });
}
