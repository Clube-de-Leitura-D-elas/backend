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
