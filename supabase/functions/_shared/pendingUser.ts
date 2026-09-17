import { isUuid } from "./uuid.ts";
/**
 * Lê `pending_user_id` do corpo JSON de uma requisição POST.
 * Retorna o id, ou uma Response de erro para devolver direto.
 */ export async function readPendingUserId(req) {
  if (req.method !== "POST") {
    return Response.json({
      error: "expected POST request"
    }, {
      status: 405
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    return Response.json({
      error: "expected JSON body"
    }, {
      status: 400
    });
  }
  const id = body?.pending_user_id;
  if (!isUuid(id)) {
    return Response.json({
      error: 'missing/invalid "pending_user_id"'
    }, {
      status: 400
    });
  }
  return id;
}
