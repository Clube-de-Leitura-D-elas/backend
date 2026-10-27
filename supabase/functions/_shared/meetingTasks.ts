export const TASKS_TOTAL = 2;

export type RecordStatus = "LOCKED" | "PENDING" | "DRAFT" | "PUBLISHED";

type MeetingState = {
  status: string;
  date: string | null;
  location_id: string | null;
};

/** Linha de `meeting_records`: `published_at` nulo é rascunho. */
export type RecordRow = { published_at: string | null };

export function isScheduleDone(meeting: MeetingState): boolean {
  return meeting.status !== "CREATED" && meeting.date !== null &&
    meeting.location_id !== null;
}

export function hasStarted(
  meeting: MeetingState,
  now = Date.now(),
): boolean {
  if (meeting.status === "IN_PROGRESS") return true;
  return meeting.status === "SCHEDULED" && meeting.date !== null &&
    Date.parse(meeting.date) <= now;
}

/** Fotos e resumo liberam quando o encontro começa e seguem depois de encerrado. */
export function canRecord(meeting: MeetingState, now = Date.now()): boolean {
  return meeting.status === "CONCLUDED" ||
    (isScheduleDone(meeting) && hasStarted(meeting, now));
}

/** Encerrar exige o encontro já iniciado e ao menos uma foto enviada. */
export function canConclude(
  meeting: MeetingState,
  photoCount: number,
  now = Date.now(),
): boolean {
  return isScheduleDone(meeting) && hasStarted(meeting, now) &&
    photoCount > 0;
}

/** O PostgREST pode devolver o registro como objeto ou como lista. */
export function firstRecord(
  value: RecordRow | RecordRow[] | null | undefined,
): RecordRow | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function recordStatus(
  meeting: MeetingState,
  record: RecordRow | null,
  now = Date.now(),
): RecordStatus {
  if (!canRecord(meeting, now)) return "LOCKED";
  if (!record) return "PENDING";
  return record.published_at ? "PUBLISHED" : "DRAFT";
}

/** A tarefa 2 conta como feita com ao menos uma foto: publicar é o encerramento. */
export function countDoneTasks(
  meeting: MeetingState,
  photoCount: number,
): number {
  return Number(isScheduleDone(meeting)) + Number(photoCount > 0);
}