// Envio de push pela FCM HTTP v1, sem SDK: o access token OAuth2 sai de um JWT
// assinado com a chave da service account do Firebase, guardada no secret
// FIREBASE_SERVICE_ACCOUNT (o JSON inteiro da chave).
//
// Nada aqui lança: falha de configuração, de OAuth ou do FCM volta como
// SendResult, para a send-push só logar e seguir sem afetar a notificação
// in-app. O motivo devolvido nunca leva o token do aparelho nem a chave.

const SECRET_NAME = "FIREBASE_SERVICE_ACCOUNT";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 10_000;
// Renova o access token um pouco antes de vencer (a doc dá 1 hora de vida).
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export type PushMessage = {
  title: string;
  body: string;
  // O FCM só aceita string em `data`; quem monta a mensagem já converte.
  data: Record<string, string>;
};

// invalid_token: o FCM disse que o token não existe mais, pode apagar.
// temporary: sobrecarga ou limite; o mesmo envio pode funcionar depois.
// failed: o resto (configuração, payload, credencial); só log.
export type SendResult =
  | { status: "sent" }
  | { status: "invalid_token" }
  | { status: "temporary"; reason: string }
  | { status: "failed"; reason: string };

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

type CachedAccessToken = { value: string; expiresAt: number };

let cachedAccount: { source: string; account: ServiceAccount } | null = null;
let cachedKey: { pem: string; key: CryptoKey } | null = null;
let cachedToken: CachedAccessToken | null = null;

export async function sendFcmMessage(
  deviceToken: string,
  message: PushMessage,
): Promise<SendResult> {
  const account = loadServiceAccount();
  if (!account) {
    return { status: "failed", reason: `${SECRET_NAME} missing or invalid` };
  }

  const accessToken = await getAccessToken(account);
  if (!accessToken) {
    return { status: "failed", reason: "oauth token request failed" };
  }

  let response: Response;
  try {
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: message.data,
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return { status: "temporary", reason: "fcm request failed" };
  }

  if (response.ok) return { status: "sent" };

  // Credencial recusada: descarta o access token em cache para o próximo envio
  // pedir outro.
  if (response.status === 401) cachedToken = null;

  return classifyError(response.status, await readError(response));
}

type FcmError = { status?: string; message?: string; details?: unknown[] };

async function readError(response: Response): Promise<FcmError> {
  try {
    const body = await response.json();
    return (body?.error ?? {}) as FcmError;
  } catch {
    return {};
  }
}

// Só UNREGISTERED apaga sem condição. INVALID_ARGUMENT também vem quando o
// problema é o payload, e apagar um token bom por isso tiraria o aparelho de
// uma leitora; então só apaga quando o detalhe é o erro específico do FCM sobre
// o token (@type FcmError, mensagem "registration token"). Na dúvida, é falha.
function classifyError(httpStatus: number, error: FcmError): SendResult {
  const fcmError = (error.details ?? []).find((detail) =>
    (detail as { "@type"?: string })?.["@type"]?.endsWith(
      "google.firebase.fcm.v1.FcmError",
    )
  ) as { errorCode?: string } | undefined;
  const code = fcmError?.errorCode ?? error.status ?? "UNKNOWN";
  const reason = `fcm ${httpStatus} ${code}`;

  if (code === "UNREGISTERED") return { status: "invalid_token" };

  if (
    code === "INVALID_ARGUMENT" && fcmError &&
    /registration token/i.test(error.message ?? "")
  ) {
    return { status: "invalid_token" };
  }

  if (
    ["UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED"].includes(code) ||
    httpStatus === 429 || httpStatus >= 500
  ) {
    return { status: "temporary", reason };
  }

  return { status: "failed", reason };
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = Deno.env.get(SECRET_NAME);
  if (!raw) return null;
  if (cachedAccount?.source === raw) return cachedAccount.account;

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.project_id !== "string" ||
      typeof parsed?.client_email !== "string" ||
      typeof parsed?.private_key !== "string"
    ) {
      return null;
    }
    const account = {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key: parsed.private_key,
    };
    cachedAccount = { source: raw, account };
    return account;
  } catch {
    return null;
  }
}

async function getAccessToken(account: ServiceAccount): Promise<string | null> {
  if (
    cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.value;
  }

  try {
    const assertion = await signJwt(account);
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = await response.json();
    if (typeof body?.access_token !== "string") return null;

    const lifetimeSeconds = Number(body.expires_in) || 3600;
    cachedToken = {
      value: body.access_token,
      expiresAt: Date.now() + lifetimeSeconds * 1000,
    };
    return cachedToken.value;
  } catch {
    return null;
  }
}

// JWT RS256 com os claims que a doc do Google pede: iss (client_email), scope,
// aud (endpoint do token), iat e exp (no máximo 1 hora depois do iat).
async function signJwt(account: ServiceAccount): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };

  const encoder = new TextEncoder();
  const unsigned = `${base64Url(encoder.encode(JSON.stringify(header)))}.${
    base64Url(encoder.encode(JSON.stringify(claims)))
  }`;

  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

// A chave vem em PEM (PKCS#8) dentro do JSON. Se o secret foi cadastrado com
// as quebras de linha escapadas como texto (\n literal), elas são restauradas.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;

  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
