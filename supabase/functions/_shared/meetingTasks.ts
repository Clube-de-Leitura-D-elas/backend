export const TASKS_TOTAL = 2;

export type RecordStatus = "LOCKED" | "PENDING" | "DRAFT" | "PUBLISHED";

type MeetingState = {
  status: string;
  date: string | null;
  location_id: string | null;
};

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
