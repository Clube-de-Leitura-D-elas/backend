import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import type { Database } from "../_shared/database.ts";
import { oneLine } from "../_shared/log.ts";

const LOG_LABEL = "update-user-profile";

// `users.level_of_education` é enum: texto fora desta lista faria o update
// falhar com 22P02, depois de todas as validações.
const EDUCATION_LEVELS = [
  "NO_FORMAL_EDUCATION",
  "INCOMPLETE_ELEMENTARY",
  "ELEMENTARY",
  "INCOMPLETE_HIGH_SCHOOL",
  "HIGH_SCHOOL",
  "INCOMPLETE_TECHNICAL",
  "TECHNICAL",
  "INCOMPLETE_UNDERGRADUATE",
  "UNDERGRADUATE",
  "INCOMPLETE_POSTGRADUATE",
  "POSTGRADUATE",
  "INCOMPLETE_MASTERS",
  "MASTERS",
  "INCOMPLETE_DOCTORATE",
  "DOCTORATE",
  "POSTDOCTORATE",
] as const;

type EducationLevel = (typeof EDUCATION_LEVELS)[number];

const BIRTH_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

type ProfileUpdate = {
  name: string;
  phone: string;
  birthDate: string;
  job: string | null;
  levelOfEducation: EducationLevel | null;
  cityName: string | null;
  zoneName: string | null;
  suggestedBook: string | null;
  expectations: string | null;
  hasOtherReadingGroup: boolean | null;
  wantsToCoordinate: boolean | null;
};

// Salva perfil, indicação e respostas da revisão numa transação só. O app manda
// o formulário inteiro; `email` continua ignorado porque o login é
// `auth.users.email`.
Deno.serve(withSupabase<Database>({ auth: "user" }, async (req, ctx) => {
  const update = await readProfileUpdate(req);
  if (update instanceof Response) return update;

  const authUserId = ctx.userClaims?.id;
  if (!authUserId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile, error: profileError } = await ctx.supabaseAdmin
    .from("users")
    .select("id")
    .eq("user_id", authUserId)
    .maybeSingle();

  if (profileError) return serverError("profile", profileError);
  if (!profile) {
    return Response.json({ error: "User profile not found" }, { status: 404 });
  }

  // Perfil e indicação numa transação só. A função resolve cidade/zona pelo
  // nome do cadastro do painel e grava NULL quando não casa.
  const { error: updateError } = await ctx.supabaseAdmin.rpc(
    "update_user_profile",
    {
      p_user_id: profile.id,
      p_name: update.name,
      p_phone: update.phone,
      p_birth_date: update.birthDate,
      p_job: update.job,
      p_level_of_education: update.levelOfEducation,
      p_city_name: update.cityName,
      p_zone_name: update.zoneName,
      p_suggested_book: update.suggestedBook,
      p_expectations: update.expectations,
      p_has_other_reading_group: update.hasOtherReadingGroup,
      p_wants_to_coordinate: update.wantsToCoordinate,
    },
  );

  if (updateError) return serverError("update", updateError);

  return Response.json({ success: true });
}));

async function readProfileUpdate(
  req: Request,
): Promise<ProfileUpdate | Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "expected POST request" }, { status: 405 });
  }

  let body: Record<string, unknown> | null;
  try {
    body = await req.json();
  } catch {
    return badRequest("expected JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("expected JSON body");
  }

  // `email` é ignorado de propósito: o e-mail de login é `auth.users.email`,
  // que a leitora acabou de confirmar. `public.users.email` não é atualizado.
  const name = readRequiredText(body.name, "name");
  if (name instanceof Response) return name;

  const phone = readRequiredText(body.phone, "phone");
  if (phone instanceof Response) return phone;

  const birthDate = readBirthDate(body.birth_date);
  if (birthDate instanceof Response) return birthDate;

  const job = readOptionalText(body.job, "job");
  if (job instanceof Response) return job;

  const levelOfEducation = readEducationLevel(body.level_of_education);
  if (levelOfEducation instanceof Response) return levelOfEducation;

  const cityName = readOptionalText(body.city_name, "city_name");
  if (cityName instanceof Response) return cityName;

  const zoneName = readOptionalText(body.zone_name, "zone_name");
  if (zoneName instanceof Response) return zoneName;

  const suggestedBook = readOptionalText(body.suggested_book, "suggested_book");
  if (suggestedBook instanceof Response) return suggestedBook;

  const expectations = readOptionalText(body.expectations, "expectations");
  if (expectations instanceof Response) return expectations;

  const hasOtherReadingGroup = readOptionalBoolean(
    body.has_other_reading_group,
    "has_other_reading_group",
  );
  if (hasOtherReadingGroup instanceof Response) return hasOtherReadingGroup;

  const wantsToCoordinate = readOptionalBoolean(
    body.wants_to_coordinate,
    "wants_to_coordinate",
  );
  if (wantsToCoordinate instanceof Response) return wantsToCoordinate;

  return {
    name,
    phone,
    birthDate,
    job,
    levelOfEducation,
    cityName,
    zoneName,
    suggestedBook,
    expectations,
    hasOtherReadingGroup,
    wantsToCoordinate,
  };
}

function readRequiredText(value: unknown, field: string): string | Response {
  if (!isPlainText(value)) return badRequest(`missing/invalid "${field}"`);

  const text = value.trim();
  if (text.length === 0) return badRequest(`missing/invalid "${field}"`);
  return text;
}

function readOptionalText(
  value: unknown,
  field: string,
): string | null | Response {
  if (value === undefined || value === null) return null;
  if (!isPlainText(value)) return badRequest(`invalid "${field}"`);

  return value.trim() || null;
}

// O Postgres recusa NUL e surrogate solto em texto: sem isso viraria 500.
const isPlainText = (value: unknown): value is string =>
  typeof value === "string" && value.isWellFormed() && !value.includes("\0");

function readOptionalBoolean(
  value: unknown,
  field: string,
): boolean | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    return badRequest(`invalid "${field}"`);
  }
  return value;
}

function readBirthDate(value: unknown): string | Response {
  if (typeof value !== "string") {
    return badRequest('missing/invalid "birth_date" (expected YYYY-MM-DD)');
  }

  const text = value.trim();
  const match = BIRTH_DATE_REGEX.exec(text);
  if (
    !match ||
    !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  ) {
    return badRequest('missing/invalid "birth_date" (expected YYYY-MM-DD)');
  }

  return text;
}

// Compara os componentes: `new Date("2026-02-31")` rola para março calado.
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function readEducationLevel(
  value: unknown,
): EducationLevel | null | Response {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return badRequest('invalid "level_of_education"');
  }

  const level = value.trim();
  if (level.length === 0) return null;
  if (!(EDUCATION_LEVELS as readonly string[]).includes(level)) {
    return badRequest(
      `invalid "level_of_education" (expected one of: ${
        EDUCATION_LEVELS.join(", ")
      })`,
    );
  }

  return level as EducationLevel;
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function serverError(label: string, error: { message: string }): Response {
  console.error(`${LOG_LABEL} ${label} error`, oneLine(error.message));
  return Response.json({ error: "Unable to update profile" }, {
    status: 500,
  });
}
