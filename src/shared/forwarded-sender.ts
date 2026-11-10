/**
 * Finds who originally wrote a forwarded email, from the forwarded-message
 * header that Gmail, Apple Mail, Outlook and most other clients put in the
 * body. Pure string handling, so it runs in the browser and Node tests alike.
 */

export interface ForwardedSender {
  address: string;
  name: string | null;
}

const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^begin forwarded message:?$/i,
  /^_{10,}$/,
];

const HEADER_LINES_TO_SCAN = 8;
const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

/** The sender named in the first forwarded-message header of `text`, or null when there is none. */
export function forwardedSender(text: string | null | undefined): ForwardedSender | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(unquote);
  for (let index = 0; index < lines.length; index += 1) {
    if (!FORWARD_MARKERS.some((marker) => marker.test(lines[index]))) continue;
    for (const line of lines.slice(index + 1, index + 1 + HEADER_LINES_TO_SCAN)) {
      const from = /^\**from:\**\s*(.+)$/i.exec(line);
      if (!from) continue;
      const sender = parseSender(from[1]);
      if (sender) return sender;
    }
  }
  return null;
}

/** "Jane Doe <jane@x.com>", "Jane Doe [mailto:jane@x.com]" or "jane@x.com". */
function parseSender(value: string): ForwardedSender | null {
  const match = ADDRESS.exec(value);
  if (!match) return null;
  const address = match[0].toLowerCase();
  const name = (value.slice(0, match.index) + value.slice(match.index + match[0].length))
    .replace(/mailto:/gi, "")
    .replace(/[<>[\]()*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
  return { address, name: name && name.toLowerCase() !== address ? name : null };
}

/** A line without any leading "> " quote marks and surrounding space. */
function unquote(line: string): string {
  return line.replace(/^(?:\s*>)+/, "").trim();
}
