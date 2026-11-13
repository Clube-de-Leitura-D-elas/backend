import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";
import { readMeetingIdParam } from "../_shared/meeting.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

type RequestRow = {
  id: string;
  requested_at: string;
  users: { id: string; name: string; photos: { url: string } | null };
};

// Pedidos de participação aguardando decisão num encontro, do mais antigo para
// o mais novo. Só a anfitriã do encontro ou uma coordenadora do grupo vê a
// lista (403 para as demais, que o app usa para esconder o acesso). Pedido de
// conta inativada fica de fora, porque não pode ser aceito.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const meetingId = readMeetingIdParam(new URL(req.url));
  if (meetingId instanceof Response) return meetingId;

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
      "get-meeting-guest-requests profile",
      oneLine(profileError.message),
    );
    return serverError();
  }

  const { data: reviewerIds, error: reviewersError } = await ctx.supabaseAdmin
    .rpc("meeting_guest_reviewer_ids", { p_meeting_id: meetingId });

  if (reviewersError) {
    console.error(
      "get-meeting-guest-requests reviewers",
      oneLine(reviewersError.message),
    );
    return serverError();
  }

  // Encontro inexistente também cai aqui (lista vazia), sem revelar se existe.
  if (!profile || !((reviewerIds ?? []) as string[]).includes(profile.id)) {
    return Response.json({ error: "Forbidden: meeting reviewers only" }, {
      status: 403,
    });
  }

  const { data: meeting, error: meetingError } = await ctx.supabaseAdmin
    .from("meetings")
    .select("status, date, group_id")
    .eq("id", meetingId)
    .maybeSingle();

  if (meetingError) {
    console.error(
      "get-meeting-guest-requests meeting",
      oneLine(meetingError.message),
    );
    return serverError();
  }

  // Encontro que já passou ou saiu de SCHEDULED não aceita mais convidadas.
  if (
    !meeting || meeting.status !== "SCHEDULED" || !meeting.date ||
    new Date(meeting.date).getTime() <= Date.now()
  ) {
    return Response.json({ requests: [] });
  }

  const { data, error } = await ctx.supabaseAdmin
    .from("meeting_guest_requests")
    .select("id, requested_at, users!inner(id, name, is_active, photos(url))")
    .eq("meeting_id", meetingId)
    .eq("status", "REQUESTED")
    .eq("users.is_active", true)
    .order("requested_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("get-meeting-guest-requests list", oneLine(error.message));
    return serverError();
  }

  const requests = (data ?? []) as unknown as RequestRow[];

  // Quem passou a ter vínculo com o grupo depois de pedir não pode mais ser
  // aceita (MG010); mostrar o pedido deixaria um Aceitar que sempre falha.
  const { data: links, error: linksError } = requests.length === 0
    ? { data: [], error: null }
    : await ctx.supabaseAdmin
      .from("group_users")
      .select("user_id")
      .eq("group_id", meeting.group_id);

  if (linksError) {
    console.error(
      "get-meeting-guest-requests links",
      oneLine(linksError.message),
    );
    return serverError();
  }

  const linked = new Set((links ?? []).map((link) => link.user_id));
  const rows = requests.filter((row) => !linked.has(row.users.id));

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    rows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    requests: rows.map((row) => ({
      request_id: row.id,
      requested_at: row.requested_at,
      user: {
        id: row.users.id,
        name: row.users.name,
        photo_url: resolvePhotoUrl(row.users.photos?.url),
      },
    })),
  });
}));

function serverError(): Response {
  return Response.json({ error: "Unable to load meeting guest requests" }, {
    status: 500,
  });
}
