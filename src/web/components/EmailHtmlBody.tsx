import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../shared/types";
import { DARK_EMAIL_BACKGROUND } from "../email-colors";
import { fixLowContrastText, lightenDarkSurfaces, neutralizeDarkSurfaces } from "../email-contrast";
import { buildEmailHtmlDocument, type EmailAppearance } from "../email-html";
import { useRootFontSize } from "../text-size";
import { cn } from "@/lib/utils";

const MIN_EMAIL_HEIGHT = 20;
const MAX_EMAIL_HEIGHT = 20_000;

/** The app's touch variant, where message text steps up from text-sm to text-base. */
const TOUCH_QUERY = "(max-width: 767px), (pointer: coarse)";

/**
 * The pixel size of a plain text message body: text-sm (14px), or text-base
 * (16px) on touch screens, scaled with the device's text size.
 */
function useMessageTextSize() {
  const rootSize = useRootFontSize();
  const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(TOUCH_QUERY);
    const update = () => setTouch(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return ((touch ? 16 : 14) * rootSize) / 16;
}

export function EmailHtmlBody({
  html,
  attachments,
  sender,
  appearance,
}: {
  html: string;
  attachments: Attachment[];
  sender: string;
  appearance: EmailAppearance;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const textSize = useMessageTextSize();
  const sourceDocument = useMemo(
    () => buildEmailHtmlDocument(html, attachments, appearance, textSize),
    [appearance, attachments, html, textSize],
  );

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
    },
    [],
  );

  const fitContent = () => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document) return;
    if (appearance === "dark") {
      neutralizeDarkSurfaces(document);
      fixLowContrastText(document, DARK_EMAIL_BACKGROUND);
    } else if (appearance === "light") {
      lightenDarkSurfaces(document);
      fixLowContrastText(document, "#ffffff");
    }
    trimOuterMargins(document);

    const resize = () => {
      // The root's scrollHeight never drops below the frame's own height, so a
      // frame that was once taller (or the 150px default) never shrinks. The
      // root's box height follows the content alone.
      const measuredHeight = Math.max(
        document.documentElement.getBoundingClientRect().height,
        document.body?.scrollHeight ?? 0,
        MIN_EMAIL_HEIGHT,
      );
      frame.style.height = `${Math.min(Math.ceil(measuredHeight), MAX_EMAIL_HEIGHT)}px`;
    };

    resizeObserverRef.current?.disconnect();
    const observer = new ResizeObserver(resize);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    resizeObserverRef.current = observer;
    resize();
  };

  return (
    <iframe
      ref={frameRef}
      title={`Email from ${sender}`}
      srcDoc={sourceDocument}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      onLoad={fitContent}
      className={cn(
        "mt-3 block min-h-5 w-full border-0",
        appearance === "dark" ? "bg-transparent" : "bg-white dark:rounded-md",
      )}
    />
  );
}

/**
 * Drops the top margin of the email's first block and the bottom margin of its
 * last one (a paragraph's 1em, say), so the card's own padding is the only
 * space around the content.
 */
function trimOuterMargins(document: Document) {
  for (const edge of ["first", "last"] as const) {
    let element = edge === "first" ? document.body?.firstElementChild : document.body?.lastElementChild;
    while (element instanceof document.defaultView!.HTMLElement) {
      if (edge === "first") element.style.setProperty("margin-top", "0", "important");
      else element.style.setProperty("margin-bottom", "0", "important");
      element = edge === "first" ? element.firstElementChild : element.lastElementChild;
    }
  }
}
