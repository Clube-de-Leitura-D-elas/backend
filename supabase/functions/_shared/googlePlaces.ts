import { oneLine } from "./log.ts";

const PLACES_API_URL = "https://places.googleapis.com/v1";
const LANGUAGE_CODE = "pt-BR";
const REGION_CODE = "BR";

export type PlaceSuggestion = {
  googlePlaceId: string;
  name: string;
  address: string;
};

export type PlaceDetails = PlaceSuggestion & {
  latitude: string;
  longitude: string;
};

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
};

/** Ids do Google têm só letras, números, "_" e "-". */
export function isGooglePlaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,300}$/.test(value);
}

async function callPlacesApi(
  url: string,
  init: RequestInit,
  logLabel: string,
  notFound?: Response,
): Promise<unknown | Response> {
  const key = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!key) {
    console.error(`${logLabel} missing GOOGLE_PLACES_API_KEY`);
    return Response.json({ error: "place search is not configured" }, {
      status: 500,
    });
  }

  const headers = new Headers(init.headers);
  headers.set("X-Goog-Api-Key", key);

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    console.error(
      `${logLabel} google places request failed`,
      oneLine(String(error)),
    );
    return Response.json({ error: "place search failed" }, { status: 502 });
  }

  if (notFound && (response.status === 400 || response.status === 404)) {
    await response.body?.cancel();
    return notFound;
  }

  if (!response.ok) {
    console.error(
      `${logLabel} google places error ${response.status}`,
      oneLine(await response.text()),
    );
    return Response.json({ error: "place search failed" }, { status: 502 });
  }

  return await response.json();
}

export async function searchGooglePlaces(
  query: string,
  logLabel: string,
): Promise<PlaceSuggestion[] | Response> {
  const result = await callPlacesApi(
    `${PLACES_API_URL}/places:searchText`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: LANGUAGE_CODE,
        regionCode: REGION_CODE,
        pageSize: 5,
      }),
    },
    logLabel,
  );
  if (result instanceof Response) return result;

  const places = (result as { places?: GooglePlace[] }).places ?? [];
  return places.flatMap((place) => {
    const name = place.displayName?.text?.trim();
    const address = place.formattedAddress?.trim();
    if (!isGooglePlaceId(place.id) || !name || !address) return [];
    return [{ googlePlaceId: place.id, name, address }];
  });
}

export async function getGooglePlace(
  googlePlaceId: string,
  logLabel: string,
): Promise<PlaceDetails | Response> {
  const url = new URL(`${PLACES_API_URL}/places/${googlePlaceId}`);
  url.searchParams.set("languageCode", LANGUAGE_CODE);
  url.searchParams.set("regionCode", REGION_CODE);

  const result = await callPlacesApi(
    url.toString(),
    {
      headers: {
        "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
      },
    },
    logLabel,
    Response.json({ error: 'invalid "google_place_id"' }, { status: 400 }),
  );
  if (result instanceof Response) return result;

  const place = result as GooglePlace;
  const name = place.displayName?.text?.trim();
  const address = place.formattedAddress?.trim();
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (
    !name || !address || typeof latitude !== "number" ||
    typeof longitude !== "number"
  ) {
    console.error(`${logLabel} incomplete google place ${googlePlaceId}`);
    return Response.json({ error: "place lookup failed" }, { status: 502 });
  }

  return {
    googlePlaceId,
    name,
    address,
    latitude: String(latitude),
    longitude: String(longitude),
  };
}
