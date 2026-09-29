import { useEffect, useMemo, useRef } from "react";
import type { Attachment } from "../../shared/types";
import { fixLowContrastText, neutralizeDarkSurfaces } from "../email-contrast";
import { buildEmailHtmlDocument, type EmailAppearance } from "../email-html";
import { cn } from "@/lib/utils";

const MIN_EMAIL_HEIGHT = 20;
const MAX_EMAIL_HEIGHT = 20_000;

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
  const sourceDocument = useMemo(
    () => buildEmailHtmlDocument(html, attachments, appearance),
    [appearance, attachments, html],
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
      fixLowContrastText(document);
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
        appearance === "original" ? "bg-white dark:rounded-md" : "bg-transparent",
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
