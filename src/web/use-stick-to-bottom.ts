import { useEffect, useRef, type RefObject } from "react";

// How close to the bottom still counts as "at the latest message".
const NEAR_BOTTOM_PX = 48;

/**
 * Keeps a scroll container at its bottom while its content settles.
 *
 * A conversation opens at the latest message. Email bodies render in iframes
 * that grow after load (images, dark-mode rendering), so the view stays pinned
 * to the bottom as the content changes size, until the person scrolls or
 * interacts with it. A new entry arriving while the view is already at the
 * bottom pins it again.
 */
export function useStickToBottom(
  containerRef: RefObject<HTMLElement | null>,
  resetKey: unknown,
  ready: boolean,
  entryCount: number,
) {
  const pinned = useRef(true);
  const nearBottom = useRef(true);
  const lastCount = useRef(0);

  // Every newly opened conversation starts pinned to the bottom.
  useEffect(() => {
    pinned.current = true;
    nearBottom.current = true;
    lastCount.current = 0;
  }, [resetKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;

    let pinnedTop = container.scrollTop;
    const distanceFromBottom = () =>
      container.scrollHeight - container.clientHeight - container.scrollTop;
    const release = () => {
      pinned.current = false;
    };
    // Scrolling up hands control back to the person. This is read from the
    // position because wheel and touch events over an email iframe stay inside
    // the iframe and never reach this container. It is checked before every
    // forced scroll too, since a resize can land before the scroll event does.
    const noticeScroll = () => {
      nearBottom.current = distanceFromBottom() <= NEAR_BOTTOM_PX;
      if (container.scrollTop < pinnedTop - 1 && !nearBottom.current) release();
      else if (nearBottom.current) pinnedTop = container.scrollTop;
    };
    const scrollToBottom = () => {
      noticeScroll();
      if (!pinned.current) return;
      container.scrollTop = container.scrollHeight;
      pinnedTop = container.scrollTop;
      nearBottom.current = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        release();
      }
    };

    container.addEventListener("scroll", noticeScroll, { passive: true });
    // Clicking in the conversation (showing quoted text, opening a menu) or
    // scrolling with the keyboard also hands control back.
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("pointerdown", release);

    // Content growing (iframes resizing, images loading) or the container
    // shrinking (the composer growing) keeps the view at the bottom.
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);

    scrollToBottom();
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", noticeScroll);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("pointerdown", release);
    };
  }, [containerRef, ready, resetKey]);

  // A new message or note re-pins the view when the person is already at the bottom.
  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;
    if (entryCount > lastCount.current && lastCount.current > 0 && nearBottom.current) {
      pinned.current = true;
    }
    lastCount.current = entryCount;
    if (pinned.current) container.scrollTop = container.scrollHeight;
  }, [containerRef, entryCount, ready]);
}
