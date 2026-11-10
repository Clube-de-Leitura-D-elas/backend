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

const OPEN_MEETING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Escolhe o encontro atual, nesta ordem:
 * 1. `IN_PROGRESS`;
 * 2. `SCHEDULED` já iniciado e ainda não encerrado, o mais recente (até 30 dias após a data);
 * 3. `SCHEDULED` ou `CREATED` com data futura, o mais próximo;
 * 4. Rascunho `CREATED` sem data.
 * Encontros `ENDED` e `CONCLUDED` nunca são escolhidos.
 */
export function pickCurrentMeeting<T extends MeetingTiming>(
  meetings: readonly T[],
  now = Date.now(),
): T | undefined {
  const open = meetings.filter((meeting) =>
    meeting.status !== "ENDED" && meeting.status !== "CONCLUDED"
  );

  const inProgress = open.find((meeting) => meeting.status === "IN_PROGRESS");
  if (inProgress) return inProgress;

  const started = open.filter((meeting) =>
    hasStarted(meeting, now) &&
    now - Date.parse(meeting.date ?? "") <= OPEN_MEETING_WINDOW_MS
  );
  if (started.length > 0) {
    return started.reduce((latest, meeting) =>
      Date.parse(meeting.date ?? "") > Date.parse(latest.date ?? "")
        ? meeting
        : latest
    );
  }

  const upcoming = open.filter((meeting) =>
    isFutureOrNowInstant(meeting.date, now)
  );
  if (upcoming.length > 0) {
    return upcoming.reduce((next, meeting) =>
      Date.parse(meeting.date ?? "") < Date.parse(next.date ?? "")
        ? meeting
        : next
    );
  }

  return open.find((meeting) => meeting.status === "CREATED" && !meeting.date);
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
