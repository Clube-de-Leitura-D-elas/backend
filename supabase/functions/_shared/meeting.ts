import type { SupabaseContext } from "jsr:@supabase/server@^1";
import type { Database } from "./database.ts";
import { isUuid } from "./uuid.ts";

/**
 * Lê `meeting_id` da query string.
 * Retorna o id, ou uma Response de erro para devolver direto.
 */
export function readMeetingIdParam(url: URL): string | Response {
  const id = url.searchParams.get("meeting_id");
  if (!isUuid(id)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, { status: 400 });
  }
  return id;
}

export async function findMeetingGroupId(
  ctx: SupabaseContext<Database>,
  meetingId: string,
  logLabel: string,
): Promise<string | Response> {
  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select("group_id")
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(`${logLabel} meeting error`, error.message.replace(/[\r\n]/g, " "));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  return data.group_id as string;
}
