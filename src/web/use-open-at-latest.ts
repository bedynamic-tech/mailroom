import { useEffect, useRef, type RefObject } from "react";

// How close to the end still counts as "at the latest message".
const NEAR_BOTTOM_PX = 48;
// Space left above the latest message once it is scrolled into place.
const TOP_GAP_PX = 12;

/** Marks each message or note in the conversation, so the latest can be found. */
export const ENTRY_ATTRIBUTE = "data-thread-entry";

/**
 * Opens a conversation at the start of its latest message, and keeps what the
 * person is reading still while the conversation loads.
 *
 * The latest message or note is scrolled so its top sits at the top of the
 * view, so a new email is read from its first line instead of its last. A
 * short latest message simply ends at the bottom of the view.
 *
 * Email bodies render in iframes that grow after load (images, dark-mode
 * rendering), which moves everything below them. The browser's own scroll
 * anchoring is turned off on the container (`overflow-anchor: none`), because
 * it moves the view by itself, which reads as the person scrolling, and it
 * does not run on iOS at all. Instead this hook keeps one entry still: the
 * latest one until the person scrolls or interacts, then whichever entry is at
 * the top of the view. A new entry arriving while the person is at the end of
 * the conversation is brought into place the same way.
 */
export function useOpenAtLatest(
  containerRef: RefObject<HTMLElement | null>,
  resetKey: unknown,
  ready: boolean,
  entryCount: number,
) {
  const pinned = useRef(true);
  const nearBottom = useRef(true);
  const lastCount = useRef(0);
  const anchorRef = useRef<() => void>(() => {});

  // Every newly opened conversation starts pinned to its latest message.
  useEffect(() => {
    pinned.current = true;
    nearBottom.current = true;
    lastCount.current = 0;
  }, [resetKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;

    const maxTop = () => Math.max(container.scrollHeight - container.clientHeight, 0);
    const entries = () =>
      Array.from(container.querySelectorAll<HTMLElement>(`[${ENTRY_ATTRIBUTE}]`));
    const offsetOf = (element: HTMLElement) =>
      element.getBoundingClientRect().top - container.getBoundingClientRect().top;

    // The entry kept still while content resizes, and where it sits in the view.
    let held: HTMLElement | null = null;
    let heldOffset = TOP_GAP_PX;
    // The position this hook last scrolled to. Any other position the
    // container reports was the person scrolling (or iOS rubber-banding).
    let ownTop = container.scrollTop;

    const scrollTo = (top: number) => {
      container.scrollTop = Math.min(Math.max(Math.round(top), 0), maxTop());
      ownTop = container.scrollTop;
      nearBottom.current = maxTop() - ownTop <= NEAR_BOTTOM_PX;
    };
    // Holds the entry at the top of the view, where the person is reading.
    const holdVisible = () => {
      const list = entries();
      const viewTop = container.getBoundingClientRect().top;
      held = list.find((entry) => entry.getBoundingClientRect().bottom > viewTop) ?? null;
      heldOffset = held ? offsetOf(held) : 0;
    };
    const release = () => {
      if (!pinned.current) return;
      pinned.current = false;
      holdVisible();
    };
    const onScroll = () => {
      const top = container.scrollTop;
      nearBottom.current = maxTop() - Math.min(Math.max(top, 0), maxTop()) <= NEAR_BOTTOM_PX;
      // The position the browser clamps to after the content shrinks is not
      // the person scrolling.
      if (Math.abs(top - ownTop) <= 1 || (top >= maxTop() - 1 && ownTop > maxTop())) {
        ownTop = top;
        return;
      }
      ownTop = top;
      pinned.current = false;
      holdVisible();
    };
    // Puts the held entry back where it was, after content above it resized.
    const anchor = () => {
      if (pinned.current) {
        const list = entries();
        held = list[list.length - 1] ?? null;
        heldOffset = TOP_GAP_PX;
        if (!held) return scrollTo(maxTop());
      }
      if (!held || !held.isConnected) return;
      const drift = offsetOf(held) - heldOffset;
      // The latest entry can sit below the end of the scroll range until its
      // body loads, so the drift stays until the range grows to reach it.
      if (Math.abs(drift) >= 1) scrollTo(container.scrollTop + drift);
    };
    anchorRef.current = anchor;
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        release();
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    // Clicking in the conversation (showing quoted text, opening a menu) or
    // scrolling with the keyboard also hands control back.
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("pointerdown", release);

    // Content growing (iframes resizing, images loading) or the container
    // changing size (the composer growing) puts the held entry back in place.
    const observer = new ResizeObserver(anchor);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);

    anchor();
    return () => {
      anchorRef.current = () => {};
      observer.disconnect();
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("pointerdown", release);
    };
  }, [containerRef, ready, resetKey]);

  // A new message or note is brought into place when the person is at the end.
  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;
    if (entryCount > lastCount.current && lastCount.current > 0 && nearBottom.current) {
      pinned.current = true;
    }
    lastCount.current = entryCount;
    anchorRef.current();
  }, [containerRef, entryCount, ready]);
}
