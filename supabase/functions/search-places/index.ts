import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { searchGooglePlaces } from "../_shared/googlePlaces.ts";

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 100;

Deno.serve(withSupabase<Database>({ auth: "user" }, async (req) => {
  const query = new URL(req.url).searchParams.get("query")?.trim() ?? "";
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return Response.json({ error: 'missing/invalid "query"' }, {
      status: 400,
    });
  }

  const places = await searchGooglePlaces(query, "search-places");
  if (places instanceof Response) return places;

  return Response.json({
    places: places.map((place) => ({
      google_place_id: place.googlePlaceId,
      name: place.name,
      address: place.address,
    })),
  });
}));
