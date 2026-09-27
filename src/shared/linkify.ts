export type PlainTextSegment =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string };

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'“”‘’]+/gi;
const ALWAYS_TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  "!",
  "?",
  ";",
  ":",
  "。",
  "，",
  "！",
  "？",
  "；",
  "：",
  "、",
  "…",
]);
const BALANCED_CLOSERS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
  "）": "（",
  "】": "【",
  "》": "《",
};

export function linkifyPlainText(input: string): PlainTextSegment[] {
  const segments: PlainTextSegment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (isPartOfEmailOrWord(input, start)) continue;

    const raw = match[0];
    const value = trimTrailingPunctuation(raw);
    if (!value || !isValidWebUrl(value)) continue;

    if (start > cursor) segments.push({ type: "text", value: input.slice(cursor, start) });
    segments.push({
      type: "link",
      value,
      href: value.toLowerCase().startsWith("www.") ? `https://${value}` : value,
    });
    cursor = start + value.length;
  }

  if (cursor < input.length) segments.push({ type: "text", value: input.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: "text", value: input }];
}

export function removeRedundantGoogleRedirects(input: string): string {
  const lines = input.split("\n");
  const visibleLines: string[] = [];

  for (const line of lines) {
    const redirectTarget = googleRedirectTarget(line.trim());
    const previous = visibleLines.at(-1)?.trim();
    if (redirectTarget && previous && sameUrl(previous, redirectTarget)) continue;
    visibleLines.push(line);
  }

  return visibleLines.join("\n");
}

function isPartOfEmailOrWord(input: string, start: number): boolean {
  if (start === 0) return false;
  return /[\p{L}\p{N}_@]/u.test(input[start - 1]);
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (ALWAYS_TRAILING_PUNCTUATION.has(character)) {
      end -= 1;
      continue;
    }

    const opener = BALANCED_CLOSERS[character];
    if (opener && count(value.slice(0, end), character) > count(value.slice(0, end), opener)) {
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function count(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function isValidWebUrl(value: string): boolean {
  try {
    const candidate = new URL(value.toLowerCase().startsWith("www.") ? `https://${value}` : value);
    return candidate.protocol === "http:" || candidate.protocol === "https:";
  } catch {
    return false;
  }
}

function googleRedirectTarget(value: string): string | null {
  const match = value.match(/^<((?:https:\/\/)?www\.google\.com\/url\?[^<>]+)>$/i);
  if (!match) return null;

  try {
    const redirect = new URL(match[1].startsWith("http") ? match[1] : `https://${match[1]}`);
    return redirect.searchParams.get("q") || redirect.searchParams.get("url");
  } catch {
    return null;
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}
