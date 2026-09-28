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
