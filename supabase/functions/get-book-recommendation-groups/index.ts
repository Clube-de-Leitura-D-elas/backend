import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "get-book-recommendation-groups";

type GroupRow = {
  id: string;
  number: number;
  photos: { url: string } | null;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const bookId = new URL(req.url).searchParams.get("bookId");
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

  const { data: book, error: bookError } = await ctx.supabaseAdmin
    .from("books")
    .select("id")
    .eq("id", bookId)
    .maybeSingle();
  if (bookError) return dbError("book", bookError);
  if (!book) {
    return Response.json({ error: "book_not_found" }, { status: 404 });
  }

  const { data: memberships, error: membershipError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("group_id, groups!inner(id, number, photos(url))")
    .eq("user_id", profile.id)
    .eq("registration_status", "ACTIVE")
    .eq("groups.is_active", true);
  if (membershipError) return dbError("groups", membershipError);

  const rows = (memberships ?? []) as unknown as {
    group_id: string;
    groups: GroupRow;
  }[];
  const groupIds = [...new Set(rows.map((row) => row.group_id))];
  if (groupIds.length === 0) return Response.json({ items: [] });

  const { data: suggestions, error: suggestionError } = await ctx.supabaseAdmin
    .from("book_suggestions")
    .select("group_id")
    .eq("book_id", bookId)
    .in("group_id", groupIds);
  if (suggestionError) return dbError("suggestions", suggestionError);

  const recommendedGroupIds = new Set(
    (suggestions ?? []).map((suggestion) => suggestion.group_id),
  );
  const uniqueGroups = new Map<string, GroupRow>();
  for (const row of rows) uniqueGroups.set(row.group_id, row.groups);
  const groups = [...uniqueGroups.entries()]
    .sort(([, left], [, right]) => left.number - right.number);
  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    groups.map(([, group]) => group.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    items: groups.map(([groupId, group]) => ({
      group_id: groupId,
      number: group.number,
      name: `Grupo ${group.number}`,
      photo_url: resolvePhotoUrl(group.photos?.url),
      already_recommended: recommendedGroupIds.has(groupId),
    })),
  });
}));

function dbError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to load recommendation groups" }, {
    status: 500,
  });
}
