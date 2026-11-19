export const UFS = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
] as const;

export const MAX_LOCATION_NAME_LENGTH = 100;

export const isUf = (value: unknown): value is string =>
  typeof value === "string" && (UFS as readonly string[]).includes(value);

export const readLocationName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= MAX_LOCATION_NAME_LENGTH ? name : null;
};

export const normalizeLocationName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();

// Códigos que o trigger `groups_location_active` levanta ao ativar ou mover um
// grupo para cidade/zona inativa. As functions checam antes, mas só o trigger
// fecha a corrida com a desativação; este mapa traduz o erro dele.
const INACTIVE_LOCATION_ERRCODES: Record<string, "city_inactive" | "zone_inactive"> = {
  CZ007: "city_inactive",
  CZ008: "zone_inactive",
};

export const inactiveLocationCode = (
  error: { code?: string } | null,
): "city_inactive" | "zone_inactive" | null =>
  error?.code && Object.hasOwn(INACTIVE_LOCATION_ERRCODES, error.code)
    ? INACTIVE_LOCATION_ERRCODES[error.code]
    : null;

export const inactiveLocationResponse = (
  code: "city_inactive" | "zone_inactive",
  status: 400 | 409,
) =>
  Response.json(
    {
      error: code === "city_inactive" ? "city is inactive" : "zone is inactive",
      code,
    },
    { status },
  );
