import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { nowIso } from "../_shared/date.ts";
import { readGroupIdParam, requireGroupMember } from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { pickCurrentMeeting } from "../_shared/meetingTasks.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

type GroupUserRow = {
  id: string;
  is_coordinator: boolean;
  users: {
    id: string;
    name: string;
    photos: { url: string } | null;
  };
};

type CurrentMeetingRow = {
  id: string;
  host_id: string;
  date: string | null;
  status: string;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const denied = await requireGroupMember(ctx, groupId);
  if (denied) return denied;

  const { data: group, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-participants group error",
      oneLine(groupError.message),
    );
    return Response.json(
      { error: "Unable to load group participants" },
      { status: 500 },
    );
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  // Mesmo recorte da contagem de get-group-details (todos os vínculos do
  // grupo), para o número do título bater com o tamanho da lista.
  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id, is_coordinator, users!inner(id, name, photos(url))")
    .eq("group_id", groupId);

  if (error) {
    console.error(
      "get-group-participants error",
      oneLine(error.message),
    );
    return Response.json(
      { error: "Unable to load group participants" },
      { status: 500 },
    );
  }

  const currentIso = nowIso();
  const nowMs = Date.parse(currentIso);
  const { data: meetingsData, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, host_id, date, status")
    .eq("group_id", groupId)
    .in("status", ["CREATED", "SCHEDULED", "IN_PROGRESS"])
    .order("date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });

  if (meetingsError) {
    console.error(
      "get-group-participants meetings error",
      oneLine(meetingsError.message),
    );
    return Response.json(
      { error: "Unable to load group participants" },
      { status: 500 },
    );
  }

  const meetings = (meetingsData ?? []) as unknown as CurrentMeetingRow[];
  const currentHostGroupUserId = pickCurrentMeeting(meetings, nowMs)?.host_id ??
    null;

  const rows = (data ?? []) as unknown as GroupUserRow[];

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    rows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    participants: rows.map((row) => ({
      id: row.users.id,
      name: row.users.name,
      photo_url: resolvePhotoUrl(row.users.photos?.url),
      role: row.is_coordinator ? "coordinator" : "member",
      is_coordinator: row.is_coordinator,
      is_host: row.id === currentHostGroupUserId,
    })),
  });
}));
