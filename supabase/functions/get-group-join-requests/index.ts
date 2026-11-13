import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam, requireGroupCoordinator } from "../_shared/group.ts";
import { oneLine } from "../_shared/log.ts";
import { resolveProfilePhotoUrls } from "../_shared/profilePhoto.ts";

type RequestRow = {
  id: string;
  requested_at: string | null;
  users: { id: string; name: string; photos: { url: string } | null };
};

// Pedidos de entrada aguardando a coordenadora, do mais antigo para o mais
// novo. Só coordenadora ativa do grupo vê a lista; pedido de conta inativada
// fica de fora, porque não pode ser aprovado.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  if (req.method !== "GET") {
    return Response.json({ error: "expected GET request" }, { status: 405 });
  }

  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const denied = await requireGroupCoordinator(
    ctx,
    groupId,
    "get-group-join-requests",
  );
  if (denied) return denied;

  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select("id, requested_at, users!inner(id, name, is_active, photos(url))")
    .eq("group_id", groupId)
    .eq("registration_status", "REQUESTED")
    .eq("users.is_active", true)
    .order("requested_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("get-group-join-requests list", oneLine(error.message));
    return serverError();
  }

  const rows = (data ?? []) as unknown as RequestRow[];

  const resolvePhotoUrl = await resolveProfilePhotoUrls(
    ctx,
    req,
    rows.map((row) => row.users.photos?.url),
  );
  if (resolvePhotoUrl instanceof Response) return resolvePhotoUrl;

  return Response.json({
    requests: rows.map((row) => ({
      group_user_id: row.id,
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
  return Response.json({ error: "Unable to load group join requests" }, {
    status: 500,
  });
}
