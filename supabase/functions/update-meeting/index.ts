import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseContext, withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { formatMeetingWhen } from "../_shared/date.ts";
import { getGooglePlace, isGooglePlaceId } from "../_shared/googlePlaces.ts";
import {
  isGroupCoordinatorOrMeetingHost,
  requireGroupMemberProfile,
} from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { isUuid } from "../_shared/uuid.ts";

const LOG_LABEL = "update-meeting";
const EDITABLE_STATUSES = ["CREATED", "SCHEDULED"];
const MAX_DESCRIPTION_LENGTH = 2000;
// ISO 8601 com fuso explícito: //"2026-10-20T19:30:00-03:00" ou "...Z".
const ISO_DATE_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

type UpdateMeetingRequest = {
  meetingId: string;
  date: string;
  googlePlaceId: string | null;
  description: string | null;
};

type MeetingRow = {
  id: string;
  group_id: string;
  host_id: string;
  status: string;
  date: string | null;
  location_id: string | null;
  locations: { name: string; google_place_id: string } | null;
};

type MeetingLocation = {
  id: string;
  name: string;
};

type Ctx = SupabaseContext<Database>;

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  const request = await readUpdateMeetingRequest(req);
  if (request instanceof Response) return request;

  const { data, error } = await ctx.supabaseAdmin
    .from("meetings")
    .select(
      "id, group_id, host_id, status, date, location_id, " +
        "locations(name, google_place_id)",
    )
    .eq("id", request.meetingId)
    .maybeSingle();

  if (error) {
    console.error(`${LOG_LABEL} meeting error`, oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json({ error: "meeting not found" }, { status: 404 });
  }

  const meeting = data as unknown as MeetingRow;

  const member = await requireGroupMemberProfile(ctx, meeting.group_id, {
    activeOnly: true,
  });
  if (member instanceof Response) return member;

  const canEdit = await isGroupCoordinatorOrMeetingHost(
    ctx,
    meeting.group_id,
    member.profileId,
    meeting.host_id,
    LOG_LABEL,
  );
  if (canEdit instanceof Response) return canEdit;
  if (!canEdit) {
    return Response.json({
      error: "Forbidden: group coordinators or meeting host only.",
    }, { status: 403 });
  }

  if (!EDITABLE_STATUSES.includes(meeting.status)) {
    return Response.json({ error: "meeting can no longer be edited" }, {
      status: 409,
    });
  }

  if (!request.googlePlaceId && !meeting.location_id) {
    return Response.json({ error: 'missing "google_place_id"' }, {
      status: 400,
    });
  }

  let locationId = meeting.location_id;
  let locationName = meeting.locations?.name ?? null;
  if (
    request.googlePlaceId &&
    request.googlePlaceId !== meeting.locations?.google_place_id
  ) {
    const location = await findOrCreateLocation(ctx, request.googlePlaceId);
    if (location instanceof Response) return location;
    locationId = location.id;
    locationName = location.name;
  }

  const status = meeting.status === "CREATED" ? "SCHEDULED" : meeting.status;

  const { data: updated, error: updateError } = await ctx.supabaseAdmin
    .from("meetings")
    .update({
      date: request.date,
      location_id: locationId,
      description: request.description,
      status,
    })
    .eq("id", meeting.id)
    .in("status", EDITABLE_STATUSES)
    .select("id, status")
    .maybeSingle();

  if (updateError) {
    console.error(`${LOG_LABEL} update error`, oneLine(updateError.message));
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  if (!updated) {
    return Response.json({ error: "meeting can no longer be edited" }, {
      status: 409,
    });
  }

  if (locationId && locationName) {
    try {
      await notifyMeetingUpdate(ctx, {
        meeting,
        editorId: member.profileId,
        nextDate: request.date,
        nextLocationId: locationId,
        nextLocationName: locationName,
      });
    } catch (error) {
      console.error(
        `${LOG_LABEL} notification error`,
        oneLine(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return Response.json({ id: updated.id, status: updated.status });
}));

async function readUpdateMeetingRequest(
  req: Request,
): Promise<UpdateMeetingRequest | Response> {
  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "expected JSON object body" }, {
      status: 400,
    });
  }

  const meetingId = body.meeting_id;
  if (!isUuid(meetingId)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, {
      status: 400,
    });
  }

  const date = body.date;
  if (
    typeof date !== "string" || !ISO_DATE_WITH_OFFSET.test(date) ||
    Number.isNaN(Date.parse(date))
  ) {
    return Response.json({ error: 'missing/invalid "date"' }, { status: 400 });
  }

  const googlePlaceId = body.google_place_id ?? null;
  if (googlePlaceId !== null && !isGooglePlaceId(googlePlaceId)) {
    return Response.json({ error: 'invalid "google_place_id"' }, {
      status: 400,
    });
  }

  const rawDescription = body.description ?? null;
  if (rawDescription !== null && typeof rawDescription !== "string") {
    return Response.json({ error: 'invalid "description"' }, { status: 400 });
  }
  const description = typeof rawDescription === "string"
    ? rawDescription.trim() || null
    : null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    return Response.json({ error: 'invalid "description"' }, { status: 400 });
  }

  return {
    meetingId,
    date: new Date(date).toISOString(),
    googlePlaceId,
    description,
  };
}

async function notifyMeetingUpdate(
  ctx: Ctx,
  change: {
    meeting: MeetingRow;
    editorId: string;
    nextDate: string;
    nextLocationId: string;
    nextLocationName: string;
  },
): Promise<void> {
  const { meeting, editorId, nextDate, nextLocationId, nextLocationName } =
    change;
  const previousDate = meeting.date;
  const previousLocationId = meeting.location_id;
  const previousLocationName = meeting.locations?.name;
  // Primeira data ou primeiro local ainda não é mudança.
  if (!previousDate || !previousLocationId || !previousLocationName) return;

  const dateChanged = new Date(previousDate).getTime() !==
    new Date(nextDate).getTime();
  const placeChanged = previousLocationId !== nextLocationId;
  if (!dateChanged && !placeChanged) return;

  const message = meetingUpdatedMessage(
    previousDate,
    nextDate,
    previousLocationName,
    nextLocationName,
    dateChanged,
    placeChanged,
  );
  if (!message) {
    console.error(`${LOG_LABEL} notification message error`);
    return;
  }

  const { data: members, error: membersError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("user_id, users!inner(is_active)")
    .eq("group_id", meeting.group_id)
    .eq("registration_status", "ACTIVE")
    .eq("users.is_active", true);
  if (membersError) {
    console.error(
      `${LOG_LABEL} notification recipients error`,
      oneLine(membersError.message),
    );
    return;
  }

  const recipientIds = [
    ...new Set(
      (members ?? [])
        .map((row: { user_id: string | null }) => row.user_id)
        .filter((userId): userId is string =>
          typeof userId === "string" && userId !== editorId
        ),
    ),
  ];
  if (recipientIds.length === 0) return;

  const { error: notifyError } = await ctx.supabaseAdmin.rpc(
    "create_notification",
    {
      p_type: "MEETING_UPDATED",
      p_title: "Encontro remarcado",
      p_message: message,
      p_user_ids: recipientIds,
      p_meeting_id: meeting.id,
      // Cada gravação que muda data ou local é outro aviso, inclusive a
      // volta a um horário anterior. O instante desta execução ocupa o
      // lugar do updated_at, que meetings não tem.
      p_dedup_key: `MEETING_UPDATED:${meeting.id}:${new Date().toISOString()}`,
    },
  );
  if (notifyError) {
    console.error(
      `${LOG_LABEL} notification error`,
      oneLine(notifyError.message),
    );
  }
}

function meetingUpdatedMessage(
  previousDate: string,
  nextDate: string,
  previousPlace: string,
  nextPlace: string,
  dateChanged: boolean,
  placeChanged: boolean,
): string | null {
  const previousWhen = formatMeetingWhen(previousDate);
  const nextWhen = formatMeetingWhen(nextDate);
  if (!previousWhen || !nextWhen) return null;

  if (dateChanged && placeChanged) {
    return `De ${previousWhen}, no ${previousPlace} ` +
      `para ${nextWhen}, no ${nextPlace}`;
  }
  if (dateChanged) {
    return `De ${previousWhen} para ${nextWhen}, no ${nextPlace}`;
  }
  if (placeChanged) {
    return `${nextWhen}, de ${previousPlace} para ${nextPlace}`;
  }
  return null;
}

async function findOrCreateLocation(
  ctx: Ctx,
  googlePlaceId: string,
): Promise<MeetingLocation | Response> {
  const { data: existing, error } = await ctx.supabaseAdmin
    .from("locations")
    .select("id, name")
    .eq("google_place_id", googlePlaceId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`${LOG_LABEL} location lookup error`, oneLine(error.message));
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (existing) {
    return { id: existing.id as string, name: existing.name as string };
  }

  const place = await getGooglePlace(googlePlaceId, LOG_LABEL);
  if (place instanceof Response) return place;

  const { data: created, error: insertError } = await ctx.supabaseAdmin
    .from("locations")
    .insert({
      name: place.name,
      address: place.address,
      google_place_id: place.googlePlaceId,
      latitude: place.latitude,
      longitude: place.longitude,
    })
    .select("id, name")
    .single();

  if (insertError) {
    console.error(`${LOG_LABEL} location error`, oneLine(insertError.message));
    return Response.json({ error: insertError.message }, { status: 500 });
  }

  return { id: created.id as string, name: created.name as string };
}
