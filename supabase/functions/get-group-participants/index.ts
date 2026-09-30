import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { readGroupIdParam } from "../_shared/group.ts";

type GroupUserRow = {
  is_coordinator: boolean;
  users: {
    id: string;
    name: string;
    photos: { url: string } | null;
  };
};

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const groupId = readGroupIdParam(new URL(req.url));
  if (groupId instanceof Response) return groupId;

  const { data: group, error: groupError } = await ctx.supabaseAdmin
    .from("groups")
    .select("id")
    .eq("id", groupId)
    .maybeSingle();

  if (groupError) {
    console.error(
      "get-group-participants group error",
      groupError.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: groupError.message }, { status: 500 });
  }

  if (!group) {
    return Response.json({ error: "group not found" }, { status: 404 });
  }

  // Mesmo recorte da contagem de get-group-details (todos os vínculos do
  // grupo), para o número do título bater com o tamanho da lista.
  const { data, error } = await ctx.supabaseAdmin
    .from("group_users")
    .select("is_coordinator, users!inner(id, name, photos(url))")
    .eq("group_id", groupId);

  if (error) {
    console.error(
      "get-group-participants error",
      error.message.replace(/[\r\n]/g, " "),
    );
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as GroupUserRow[];

  return Response.json({
    participants: rows.map((row) => ({
      id: row.users.id,
      name: row.users.name,
      photo_url: row.users.photos?.url ?? null,
      role: row.is_coordinator ? "coordinator" : "member",
    })),
  });
}));
