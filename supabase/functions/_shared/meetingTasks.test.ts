import { hasStarted, pickCurrentMeeting } from "./meetingTasks.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      message ??
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test(
  "pickCurrentMeeting prioritizes a SCHEDULED meeting 1 hour ago over a dateless CREATED draft",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");
    const oneHourAgoIso = new Date(now - 60 * 60 * 1000).toISOString();

    const meetings = [
      {
        id: "m-scheduled",
        host_id: "host-scheduled",
        status: "SCHEDULED",
        date: oneHourAgoIso,
      },
      {
        id: "m-draft",
        host_id: "host-draft",
        status: "CREATED",
        date: null,
      },
    ];

    assertEquals(hasStarted(meetings[0], now), true);

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-scheduled");
    assertEquals(selected?.host_id, "host-scheduled");

    const participants = [
      { id: "host-scheduled", name: "Ana" },
      { id: "host-draft", name: "Bia" },
    ].map((row) => ({
      ...row,
      is_host: row.id === (selected?.host_id ?? null),
    }));

    assertEquals(participants[0].is_host, true);
    assertEquals(participants[1].is_host, false);
  },
);

Deno.test(
  "pickCurrentMeeting prioritizes an upcoming meeting over a dateless CREATED draft and past CREATED",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");
    const oneHourAgoIso = new Date(now - 60 * 60 * 1000).toISOString();
    const tomorrowIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    const meetings = [
      {
        id: "m-created-past",
        host_id: "host-past",
        status: "CREATED",
        date: oneHourAgoIso,
      },
      {
        id: "m-upcoming",
        host_id: "host-upcoming",
        status: "SCHEDULED",
        date: tomorrowIso,
      },
      {
        id: "m-draft",
        host_id: "host-draft",
        status: "CREATED",
        date: null,
      },
    ];

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-upcoming");
    assertEquals(selected?.host_id, "host-upcoming");
  },
);

Deno.test(
  "pickCurrentMeeting falls back to dateless CREATED draft when there is no active or upcoming meeting",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");

    const meetings = [
      {
        id: "m-draft",
        host_id: "host-draft",
        status: "CREATED",
        date: null,
      },
    ];

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-draft");
    assertEquals(selected?.host_id, "host-draft");
  },
);

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test(
  "pickCurrentMeeting prefers the most recent started SCHEDULED meeting over an older one still open",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");

    const meetings = [
      {
        id: "m-stale",
        host_id: "host-stale",
        status: "SCHEDULED",
        date: new Date(now - 20 * DAY_MS).toISOString(),
      },
      {
        id: "m-current",
        host_id: "host-current",
        status: "SCHEDULED",
        date: new Date(now - DAY_MS).toISOString(),
      },
    ];

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-current");
  },
);

Deno.test(
  "pickCurrentMeeting ignores started SCHEDULED meetings older than 30 days",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");

    const meetings = [
      {
        id: "m-old",
        host_id: "host-old",
        status: "SCHEDULED",
        date: new Date(now - 60 * DAY_MS).toISOString(),
      },
      {
        id: "m-draft",
        host_id: "host-draft",
        status: "CREATED",
        date: null,
      },
    ];

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-draft");
  },
);

Deno.test(
  "pickCurrentMeeting prioritizes IN_PROGRESS over a SCHEDULED meeting",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");

    const meetings = [
      {
        id: "m-in-progress",
        host_id: "host-in-progress",
        status: "IN_PROGRESS",
        date: new Date(now - 2 * DAY_MS).toISOString(),
      },
      {
        id: "m-upcoming",
        host_id: "host-upcoming",
        status: "SCHEDULED",
        date: new Date(now + DAY_MS).toISOString(),
      },
    ];

    const selected = pickCurrentMeeting(meetings, now);
    assertEquals(selected?.id, "m-in-progress");
  },
);

Deno.test(
  "pickCurrentMeeting never picks ENDED meetings",
  () => {
    const now = Date.parse("2026-11-10T20:00:00.000Z");

    const meetings = [
      {
        id: "m-ended",
        host_id: "host-ended",
        status: "ENDED",
        date: new Date(now - DAY_MS).toISOString(),
      },
    ];

    assertEquals(pickCurrentMeeting(meetings, now), undefined);
  },
);
