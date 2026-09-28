export const MAX_BOARD_COLUMNS = 20;
export const MAX_BOARD_COLUMN_NAME_LENGTH = 60;
export const MAX_BOARD_CARD_TITLE_LENGTH = 200;
export const MAX_BOARD_CARD_DESCRIPTION_LENGTH = 10_000;
export const MAX_BOARD_CARD_CONVERSATIONS = 50;
export const MAX_BOARD_NOTE_LENGTH = 5_000;

/** A Card title prefilled from a Conversation subject, without reply and forward prefixes. */
export function cardTitleFromSubject(subject: string | null | undefined): string {
  let title = (subject ?? "").trim();
  let previous = "";
  while (title !== previous) {
    previous = title;
    title = title.replace(/^(re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*/i, "").trim();
  }
  return title.slice(0, MAX_BOARD_CARD_TITLE_LENGTH);
}

/** How long before an Item's due time its reminder goes out. */
export const BOARD_REMINDER_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 0, label: "At the due time" },
  { minutes: 5, label: "5 minutes before" },
  { minutes: 15, label: "15 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 120, label: "2 hours before" },
  { minutes: 1440, label: "1 day before" },
  { minutes: 2880, label: "2 days before" },
  { minutes: 10080, label: "1 week before" },
];

export function reminderLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  return BOARD_REMINDER_OPTIONS.find((option) => option.minutes === minutes)?.label ?? `${minutes} minutes before`;
}

/** When the reminder for an Item due at `dueAt` goes out, as a UTC ISO string. */
export function reminderTime(dueAt: string, minutes: number): string {
  return new Date(Date.parse(dueAt) - minutes * 60_000).toISOString();
}

/** A due time as people read it, in the zone it was picked in when that zone is known. */
export function formatDueTime(dueAt: string, timeZone: string | null | undefined): string {
  const date = new Date(dueAt);
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone ?? "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date);
  }
}
