import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";

type GroupRow = {
  id: string;
  name: string | null;
  photos: { url: string } | null;
  cities: { name: string; uf: string } | null;
  group_genres: { genres: { name: string } | null }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const { data: group, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id, name, photos(url), cities(name, uf), group_genres(genres(name))")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error("get-group-details error", groupError);
    return Response.json({ error: groupError.message }, { status: 500 });
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  const { count: participantCount, error: countError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId);

  if (countError) {
    console.error("get-group-details participant count error", countError);
    return Response.json({ error: countError.message }, { status: 500 });
  }

  const typedGroup = group as unknown as GroupRow;

  return Response.json({
    name: typedGroup.name,
    genres: typedGroup.group_genres
      .map((gg) => gg.genres?.name)
      .filter((name): name is string => Boolean(name)),
    participant_count: participantCount ?? 0,
    city: typedGroup.cities?.name ?? null,
    state_code: typedGroup.cities?.uf ?? null,
    cover_image_url: typedGroup.photos?.url ?? null,
  });
}));