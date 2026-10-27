import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import {
  findMeetingGroupIdAndHostId,
  readMeetingIdParam,
} from "../_shared/meeting.ts";
import {
  type MeetingPhoto,
  signMeetingPhotos,
} from "../_shared/meetingPhoto.ts";

type MeetingPhotoRow = {
  is_cover: boolean;
  photos: { id: string; url: string; created_at: string } | null;
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

  const meeting = await findMeetingGroupIdAndHostId(
    ctx,
    meetingId,
    "get-meeting-photos",
  );
  if (meeting instanceof Response) return meeting;

  const member = await requireGroupMemberProfile(ctx, meeting.groupId);
  if (member instanceof Response) return member;

  // Mesma regra da add-meeting-photo: o app usa este campo para mostrar ou
  // esconder o botão de adicionar foto. Só libera depois do encerramento.
  let canAddPhotos = false;
  if (meeting.status === "CONCLUDED") {
    const allowed = await isGroupCoordinatorOrMeetingHost(
      ctx,
      meeting.groupId,
      member.profileId,
      meeting.hostId,
      "get-meeting-photos",
    );
    if (allowed instanceof Response) return allowed;
    canAddPhotos = allowed;
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("meeting_photos")
    .select("is_cover, photos!inner(id, url, created_at)")
    .eq("meeting_id", meetingId);

  if (error) {
    console.error(
      "get-meeting-photos error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: "Unable to load meeting photos" }, {
      status: 500,
    });
  }

  const photos: MeetingPhoto[] = ((data ?? []) as unknown as MeetingPhotoRow[])
    .flatMap((row) =>
      row.photos ? [{ ...row.photos, is_cover: row.is_cover }] : []
    )
    .sort((a, b) =>
      Number(b.is_cover) - Number(a.is_cover) ||
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      a.id.localeCompare(b.id)
    )
    .map((photo) => ({ id: photo.id, url: photo.url }));

  const signed = await signMeetingPhotos(ctx, req, meetingId, photos);
  if (signed instanceof Response) return signed;

  return Response.json({ photos: signed, can_add_photos: canAddPhotos });
}));