import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { readMeetingIdParam } from "../_shared/meeting.ts";
import {
  canConclude,
  isScheduleDone,
  recordStatus,
} from "../_shared/meetingTasks.ts";

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
  date: string | null;
  location_id: string | null;
  books: { name: string; author: string };
  groups: { number: number };
  locations: { name: string } | null;
  meeting_photos: { is_sketch: boolean }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, host_id, status, date, location_id, books!inner(name, author), groups!inner(number), locations(name), meeting_photos(is_sketch)",
    )
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error(
      "get-meeting-tasks error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  const member = await requireGroupMemberProfile(ctx, meeting.group_id);
  if (member instanceof Response) return member;

  // Encontros encerrados continuam acessíveis: a tarefa 2 (registro) só
  // libera depois do encerramento.
  const canManageTasks = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    "get-meeting-tasks",
  );
  if (canManageTasks instanceof Response) return canManageTasks;

  return Response.json({
    meeting_id: meeting.id,
    status: meeting.status,
    can_manage_tasks: canManageTasks,
    can_conclude: canManageTasks && canConclude(meeting),
    book_title: meeting.books.name,
    book_author: meeting.books.author,
    group_name: `Grupo ${meeting.groups.number}`,
    tasks: {
      schedule: {
        done: isScheduleDone(meeting),
        date: meeting.date,
        location: meeting.locations?.name ?? null,
      },
      record: {
        status: recordStatus(meeting.status, meeting.meeting_photos),
      },
    },
  });
}));

