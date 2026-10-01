import { isUuid } from "./uuid.ts";

/**
 * Lê `meeting_id` da query string.
 * Retorna o id, ou uma Response de erro para devolver direto.
 */
export function readMeetingIdParam(url: URL): string | Response {
  const id = url.searchParams.get("meeting_id");
  if (!isUuid(id)) {
    return Response.json({ error: 'missing/invalid "meeting_id"' }, { status: 400 });
  }
  return id;
}
