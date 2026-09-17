import { isUuid } from "./uuid.ts";
/**
 * Lê `participant_id` (id da tabela users) da query string.
 * Retorna o id, ou uma Response de erro para devolver direto.
 */ export function readParticipantIdParam(url) {
  const id = url.searchParams.get("participant_id");
  if (!isUuid(id)) {
    return Response.json({
      error: 'missing/invalid "participant_id"'
    }, {
      status: 400
    });
  }
  return id;
}
