import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";

type MembershipRow = {
  groups: {
    id: string;
    number: number;
    cities: { name: string; uf: string } | null;
    photos: { url: string } | null;
  };
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (_req, ctx) => {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error("get-my-groups profile error", profileError.message);
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select("group_id, groups!inner(id, number, cities(name, uf), photos(url))")
    .eq("user_id", profile.id)
    .order("group_id");

  if (error) {
    console.error("get-my-groups memberships error", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  const memberships = (data ?? []) as unknown as MembershipRow[];
  const groupsById = new Map(
    memberships.map((membership) => [membership.groups.id, membership.groups]),
  );
  const groups = [...groupsById.values()];
  const groupIds = groups.map((group) => group.id);

  if (groupIds.length === 0) {
    return Response.json({ groups: [] });
  }

  const { data: groupUsers, error: groupUsersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("group_id")
    .in("group_id", groupIds);

  if (groupUsersError) {
    console.error(
      "get-my-groups participant count error",
      groupUsersError.message,
    );
    return Response.json({ error: groupUsersError.message }, { status: 500 });
  }

  const countsByGroupId = new Map<string, number>();
  for (const groupUser of groupUsers ?? []) {
    countsByGroupId.set(
      groupUser.group_id,
      (countsByGroupId.get(groupUser.group_id) ?? 0) + 1,
    );
  }

  return Response.json({
    groups: groups.map((group) => {
      const city = group.cities;
      return {
        id: group.id,
        number: group.number,
        participant_count: countsByGroupId.get(group.id) ?? 0,
        city_state: city ? `${city.name}, ${city.uf}` : "",
        photo_url: group.photos?.url ?? null,
      };
    }),
  });
}));
