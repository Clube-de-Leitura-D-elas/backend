import { isUuid } from "./uuid.ts";

export function readGroupIdParam(url: URL): string | Response {
  const id = url.searchParams.get("group_id");
  if (!isUuid(id)) {
    return Response.json({ error: 'missing/invalid "group_id"' }, { status: 400 });
  }
  return id;
}