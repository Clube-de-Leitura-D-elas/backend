import { isFutureOrNowInstant } from "./date.ts";

export const TASKS_TOTAL = 2;

export type RecordStatus = "LOCKED" | "PENDING" | "DRAFT" | "PUBLISHED";

type MeetingState = {
  status: string;
  date: string | null;
  location_id: string | null;
};

type MeetingTiming = Pick<MeetingState, "status" | "date">;

export function isScheduleDone(meeting: MeetingState): boolean {
  return meeting.status !== "CREATED" && meeting.date !== null &&
    meeting.location_id !== null;
}

export function hasStarted(
  meeting: MeetingTiming,
  now = Date.now(),
): boolean {
  if (meeting.status === "IN_PROGRESS") return true;
  return meeting.status === "SCHEDULED" && meeting.date !== null &&
    Date.parse(meeting.date) <= now;
}

/**
 * Escolhe o encontro cuja anfitriã deve ser exibida na lista de participantes.
 * Prioridade:
 * 1. Encontro em andamento (`IN_PROGRESS` ou `SCHEDULED` já iniciado via `hasStarted`) ou com data futura (`date >= now`);
 * 2. Rascunho `CREATED` sem data (`date === null`).
 */
export function pickHostMeeting<T extends MeetingTiming>(
  meetings: readonly T[],
  now = Date.now(),
): T | undefined {
  return (
    meetings.find(
      (meeting) =>
        hasStarted(meeting, now) ||
        (meeting.status !== "ENDED" &&
          meeting.status !== "CONCLUDED" &&
          isFutureOrNowInstant(meeting.date, now)),
    ) ??
      meetings.find((meeting) => meeting.status === "CREATED" && !meeting.date)
  );
}

export function canConclude(meeting: MeetingState, now = Date.now()): boolean {
  return isScheduleDone(meeting) && hasStarted(meeting, now);
}

export function recordStatus(
  status: string,
  photos: { is_sketch: boolean }[],
): RecordStatus {
  if (status === "CONCLUDED") return "PUBLISHED";
  if (status !== "ENDED") return "LOCKED";
  if (photos.some((photo) => !photo.is_sketch)) return "PUBLISHED";
  return photos.length > 0 ? "DRAFT" : "PENDING";
}

export function countDoneTasks(
  meeting: MeetingState,
  photos: { is_sketch: boolean }[],
): number {
  return Number(isScheduleDone(meeting)) +
    Number(recordStatus(meeting.status, photos) === "PUBLISHED");
}
