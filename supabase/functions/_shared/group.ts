import { isUuid } from "./uuid.ts";
import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

export function readGroupIdParam(url: URL): string | Response {
  const id = url.searchParams.get("group_id");
  if (!isUuid(id)) {
    return Response.json({ error: 'missing/invalid "group_id"' }, {
      status: 400,
    });
  }
  return id;
}

export async function requireGroupMember(
  ctx: SupabaseContext<Database>,
  groupId: string,
): Promise<Response | null> {
  const member = await requireGroupMemberProfile(ctx, groupId);
  return member instanceof Response ? member : null;
}

export async function requireGroupMemberProfile(
  ctx: SupabaseContext<Database>,
  groupId: string,
): Promise<{ profileId: string } | Response> {
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
    console.error(
      "group membership profile error",
      profileError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  if (!profile) {
    return Response.json({ error: "Forbidden: group members only" }, {
      status: 403,
    });
  }

  const { data: memberships, error: membershipError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", profile.id)
    .limit(1);

  if (membershipError) {
    console.error(
      "group membership check error",
      membershipError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: membershipError.message }, { status: 500 });
  }

  if (!memberships || memberships.length === 0) {
    return Response.json({ error: "Forbidden: group members only" }, {
      status: 403,
    });
  }

  return { profileId: profile.id };
}
