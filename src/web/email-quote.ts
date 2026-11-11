/**
 * Finds the quoted history in an HTML email: the earlier messages a reply
 * carries along ("On ... wrote:" and the quote under it). Those messages are
 * already in the conversation, so the app hides them behind "Show quoted
 * text", the way plain text emails already work (see splitQuotedTail).
 *
 * Only the quote itself is marked. Content after it, such as a signature the
 * sender's client put below the quote, stays visible.
 */

/** Marks every element that belongs to the quoted history. */
export const QUOTED_ATTRIBUTE = "data-mailroom-quoted";

/** Set on the email's root element to show the quoted history again. */
export const SHOW_QUOTED_CLASS = "mailroom-show-quoted";

export const QUOTED_STYLE = `
  html:not(.${SHOW_QUOTED_CLASS}) [${QUOTED_ATTRIBUTE}] { display: none !important; }
`;

const ATTRIBUTION =
  /^\s*(On|Le|Am|El|Il|Op)\s[\s\S]{4,300}(wrote|writes|a écrit|schrieb|escribió|ha scritto|schreef)\s*:\s*$/i;
const OUTLOOK_HEADER = /^\s*From:\s[\s\S]{1,400}?\b(Sent|Date):\s/i;
const FORWARDED = /forwarded message|original message follows/i;

/**
 * Marks the email's quoted history with QUOTED_ATTRIBUTE. Returns whether
 * anything was marked. An email that is nothing but a quote (a forward, or a
 * reply with no text of its own) is left alone, so it never renders empty.
 */
export function markQuotedHistory(document: Document): boolean {
  const body = document.body;
  if (!body) return false;

  const candidates = quoteCandidates(body)
    .filter((elements) => elements.length > 0)
    .filter((elements) => !FORWARDED.test(textOf(elements[0]).slice(0, 300)))
    .sort((a, b) => (a[0].compareDocumentPosition(b[0]) & 4 /* FOLLOWING */ ? -1 : 1));

  for (const elements of candidates) {
    const first = elements[0];
    if (!hasContentBefore(first, body)) continue;
    // Blank lines and rules between the reply and its quote go with the quote.
    let previous = first.previousElementSibling;
    while (previous && !hasContent(previous)) {
      previous.setAttribute(QUOTED_ATTRIBUTE, "");
      previous = previous.previousElementSibling;
    }
    for (const element of elements) element.setAttribute(QUOTED_ATTRIBUTE, "");
    return true;
  }
  return false;
}

/** Each candidate is the run of elements that make up one quote, in order. */
function quoteCandidates(body: HTMLElement): Element[][] {
  const candidates: Element[][] = [];
  const outermost = (selector: string) =>
    [...body.querySelectorAll(selector)].filter((element) => !element.parentElement?.closest(selector));

  // Gmail, Yahoo and Proton wrap the attribution and the quote in one element.
  for (const element of outermost(
    ".gmail_quote_container, .gmail_quote, .yahoo_quoted, [id^='yahoo_quoted'], .protonmail_quote",
  )) {
    candidates.push([element]);
  }

  // Thunderbird: an attribution element, then the cited quote.
  for (const prefix of body.querySelectorAll(".moz-cite-prefix")) {
    const quote = prefix.nextElementSibling;
    candidates.push(quote?.matches("blockquote") ? [prefix, quote] : [prefix]);
  }

  // Apple Mail and others: a blockquote, sometimes after an "On ... wrote:" line.
  for (const quote of outermost("blockquote")) {
    const previous = previousContentElement(quote);
    if (previous && ATTRIBUTION.test(textOf(previous))) candidates.push([previous, quote]);
    else if (quote.getAttribute("type")?.toLowerCase() === "cite") candidates.push([quote]);
  }

  // Outlook on the web: a marker or reply header, then the original email.
  const outlook = body.querySelector("#appendonsend, [id$='divRplyFwdMsg']");
  if (outlook) candidates.push(withFollowing(outlook));

  // Outlook desktop: a "From: ... Sent: ..." header block, then the original.
  const header = [...body.querySelectorAll("div, p")].find(
    (element) =>
      OUTLOOK_HEADER.test(textOf(element)) &&
      textOf(element).length < 1000 &&
      ![...element.querySelectorAll("div, p")].some((child) => OUTLOOK_HEADER.test(textOf(child))),
  );
  if (header) {
    // Outlook wraps the header in a bordered box; take the box when the header is all it holds.
    let start: Element = header;
    while (start.parentElement && start.parentElement !== body && onlyContent(start.parentElement, start)) {
      start = start.parentElement;
    }
    candidates.push(withFollowing(start));
  }

  return candidates;
}

/** The element and every sibling after it. */
function withFollowing(element: Element): Element[] {
  const elements = [element];
  for (let next = element.nextElementSibling; next; next = next.nextElementSibling) elements.push(next);
  return elements;
}

function previousContentElement(element: Element): Element | null {
  let previous = element.previousElementSibling;
  while (previous && !hasContent(previous)) previous = previous.previousElementSibling;
  return previous;
}

/** Whether anything visible comes before the element in the body. */
function hasContentBefore(element: Element, body: HTMLElement): boolean {
  for (let node: Node | null = element; node && node !== body; node = node.parentNode) {
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (hasContent(sibling)) return true;
    }
  }
  return false;
}

/** Whether the parent holds nothing visible besides the child. */
function onlyContent(parent: Element, child: Element): boolean {
  for (const node of parent.childNodes) {
    if (node !== child && hasContent(node)) return false;
  }
  return true;
}

function hasContent(node: Node): boolean {
  if (node.nodeType === 3 /* TEXT */) return textOf(node).trim() !== "";
  if (node.nodeType !== 1 /* ELEMENT */) return false;
  const element = node as Element;
  if (["STYLE", "SCRIPT", "TITLE", "HEAD"].includes(element.tagName)) return false;
  if (element.tagName === "IMG" || element.querySelector("img")) return true;
  return textOf(element).trim() !== "";
}

function textOf(node: Node): string {
  return (node.textContent ?? "").replace(/ /g, " ");
}
