import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { requireFounder } from "../_shared/founder.ts";


export type CalendarGroup = {
    id: string;
    number: number;
    description: string;
    cityId: string;
    state: string;
};

type CalendarGroupQuery = {
    id: string;
    number: number;
    description: string;
    city_id: string;
    cities: {
        uf: string;
    } | null;
};


Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {

    const denied = await requireFounder(ctx);
    if (denied) return denied;

    const { data, error } = await ctx.supabaseAdmin
        .from("groups")
        .select(`
    id,
    number,
    description,
    city_id,
    cities (
      uf
    )
  `)
        .eq("is_active", true)
        .order("number");

    if (error) {
        console.error("get-calendar-groups error", error);
        return Response.json(
            { error: error.message },
            { status: 500 },
        );
    }

    const groups: CalendarGroup[] = (data ?? []).map((group: CalendarGroupQuery) => ({
        id: group.id,
        number: group.number,
        description: group.description,
        cityId: group.city_id,
        state: group.cities?.uf ?? "",
    }));

    return Response.json({ groups });
}));