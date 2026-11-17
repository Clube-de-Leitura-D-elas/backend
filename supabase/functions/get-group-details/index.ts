import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import {
  NOT_JOINED_FILTER,
  readGroupIdParam,
  requireGroupMember,
} from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";

const OPEN_MEETING_STATUSES = new Set([
  "CREATED",
  "SCHEDULED",
  "IN_PROGRESS",
]);

type GroupRow = {
  id: string;
  number: number;
  whatsapp_link: string | null;
  photos: { url: string } | null;
  cities: { name: string; uf: string } | null;
  group_genres: { genres: { name: string } | null }[];
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const denied = await requireGroupMember(ctx, groupId);
  if (denied) return denied;

  const { data: group, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select(
      "id, number, whatsapp_link, photos(url), cities(name, uf), group_genres(genres(name))",
    )
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-details error",
      oneLine(groupError.message),
    );
    return Response.json({ error: "Unable to load group details" }, {
      status: 500,
    });
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  const { count: participantCount, error: countError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .not("registration_status", "in", NOT_JOINED_FILTER);

  if (countError) {
    console.error(
      "get-group-details participant count error",
      oneLine(countError.message),
    );
    return Response.json({ error: "Unable to load group details" }, {
      status: 500,
    });
  }

  const authUserId = ctx.userClaims?.id;
  const { data: userMember, error: userMemberError } = await ctx.supabaseAdmin
    .from("group_users")
    .select("is_coordinator, users!inner(user_id)")
    .eq("group_id", groupId)
    .eq("users.user_id", authUserId)
    .eq("registration_status", "ACTIVE")
    .limit(1)
    .maybeSingle();

  if (userMemberError) {
    console.error(
      "get-group-details membership error",
      oneLine(userMemberError.message),
    );
    return Response.json({ error: "Unable to load group details" }, {
      status: 500,
    });
  }

  const isCoordinator = Boolean(userMember?.is_coordinator);

  const { data: meetings, error: meetingsError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("id, status")
    .eq("group_id", groupId)
    .order("date", { ascending: true })
    .order("id", { ascending: true });

  if (meetingsError) {
    console.error(
      "get-group-details meetings error",
      oneLine(meetingsError.message),
    );
    return Response.json({ error: "Unable to load group details" }, {
      status: 500,
    });
  }

  const openMeeting = (meetings ?? []).find((m) =>
    OPEN_MEETING_STATUSES.has(m.status)
  );

  let pendingRaffle: {
    type: "INAUGURAL" | "PENDING";
    meeting_id?: string;
    group_id: string;
  } | null = null;

  if (!openMeeting && isCoordinator) {
    if ((meetings ?? []).length === 0) {
      const { count: inauguralCount, error: inauguralError } = await ctx
        .supabaseAdmin
        .from("meeting_raffles")
        .select("id", { count: "exact", head: true })
        .eq("group_id", groupId)
        .is("meeting_id", null);

      if (inauguralError) {
        console.error(
          "get-group-details inaugural raffle error",
          oneLine(inauguralError.message),
        );
        return Response.json({ error: "Unable to load group details" }, {
          status: 500,
        });
      }

      if ((inauguralCount ?? 0) === 0) {
        pendingRaffle = { type: "INAUGURAL", group_id: groupId };
      }
    } else {
      const lastMeeting = meetings![meetings!.length - 1];
      if (
        lastMeeting.status === "ENDED" || lastMeeting.status === "CONCLUDED"
      ) {
        const { count: raffleCount, error: raffleError } = await ctx
          .supabaseAdmin
          .from("meeting_raffles")
          .select("id", { count: "exact", head: true })
          .eq("meeting_id", lastMeeting.id);

        if (raffleError) {
          console.error(
            "get-group-details raffle error",
            oneLine(raffleError.message),
          );
          return Response.json({ error: "Unable to load group details" }, {
            status: 500,
          });
        }

        if ((raffleCount ?? 0) === 0) {
          pendingRaffle = {
            type: "PENDING",
            meeting_id: lastMeeting.id,
            group_id: groupId,
          };
        }
      }
    }
  }

  const typedGroup = group as unknown as GroupRow;

  return Response.json({
    name: String(typedGroup.number),
    genres: typedGroup.group_genres
      .map((gg) => gg.genres?.name)
      .filter((name): name is string => Boolean(name)),
    participant_count: participantCount ?? 0,
    city: typedGroup.cities?.name ?? null,
    state_code: typedGroup.cities?.uf ?? null,
    cover_image_url: typedGroup.photos?.url ?? null,
    whatsapp_url: typedGroup.whatsapp_link,
    has_open_meeting: Boolean(openMeeting),
    open_meeting_status: openMeeting ? openMeeting.status : null,
    pending_raffle: pendingRaffle,
  });
}));
