import { useEffect, useMemo, useRef } from "react";
import type { Attachment } from "../../shared/types";
import { buildEmailHtmlDocument, type EmailAppearance } from "../email-html";
import { cn } from "@/lib/utils";

const MIN_EMAIL_HEIGHT = 80;
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

    const resize = () => {
      const measuredHeight = Math.max(
        document.documentElement.scrollHeight,
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
        "mt-3 block min-h-20 w-full border-0",
        appearance === "original" ? "bg-white dark:rounded-md" : "bg-transparent",
      )}
    />
  );
}
