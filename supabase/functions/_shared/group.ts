import { isUuid } from "./uuid.ts";
import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";

/**
 * Lê o id do grupo da query string.
 *
 * As funções do app usam `group_id`; as do painel web usam `groupId`, como o
 * resto dos parâmetros que ele envia (`pageSize`, `cityId`).
 */
export function readGroupIdParam(
  url: URL,
  key = "group_id",
): string | Response {
  const id = url.searchParams.get(key);
  if (!isUuid(id)) {
    return Response.json({ error: `missing/invalid "${key}"` }, {
      status: 400,
    });
  }
  return id;
}

/** Garante que o grupo existe, para não paginar lista de um id inventado. */
export async function requireExistingGroup(
  ctx: SupabaseContext<Database>,
  groupId: string,
): Promise<Response | null> {
  const { data: group, error } = await ctx.supabaseAdmin
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();

  if (error) {
    console.error(
      "group existence check error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  return null;
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
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<{ profileId: string } | Response> {
  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id, is_active")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) {
    console.error(
      "group membership profile error",
      profileError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: profileError.message }, { status: 500 });
  }

  if (!profile || (activeOnly && !profile.is_active)) {
    return Response.json({ error: "Forbidden: group members only" }, {
      status: 403,
    });
  }

  let membershipQuery = ctx.supabaseAdmin
    .from("group_users")
    .select("id")
    .eq("group_id", groupId)
    .eq("user_id", profile.id);
  if (activeOnly) {
    membershipQuery = membershipQuery.eq("registration_status", "ACTIVE");
  }
  const { data: memberships, error: membershipError } = await membershipQuery
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
