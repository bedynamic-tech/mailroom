import { useEffect, useRef, type RefObject } from "react";

// How close to the end still counts as "at the latest message".
const NEAR_BOTTOM_PX = 48;
// Space left above the latest message once it is scrolled into place.
const TOP_GAP_PX = 12;

/** Marks each message or note in the conversation, so the latest can be found. */
export const ENTRY_ATTRIBUTE = "data-thread-entry";

/**
 * Opens a conversation at the start of its latest message.
 *
 * The latest message or note is scrolled so its top sits at the top of the
 * view, so a new email is read from its first line instead of its last. A
 * short latest message simply ends at the bottom of the view. Email bodies
 * render in iframes that grow after load (images, dark-mode rendering), and
 * earlier messages growing pushes the latest one down, so the view keeps the
 * latest message in place while the content settles, until the person scrolls
 * or interacts with it. A new entry arriving while the person is at the end of
 * the conversation brings that entry into place the same way.
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

    const maxTop = () =>
      Math.max(container.scrollHeight - container.clientHeight, 0);
    // iOS rubber-bands past either end, reporting a scrollTop outside the range.
    const currentTop = () =>
      Math.min(Math.max(container.scrollTop, 0), maxTop());
    const targetTop = () => {
      const entries = container.querySelectorAll(`[${ENTRY_ATTRIBUTE}]`);
      const latest = entries[entries.length - 1];
      if (!(latest instanceof HTMLElement)) return maxTop();
      const offset =
        latest.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop -
        TOP_GAP_PX;
      return Math.min(Math.max(Math.round(offset), 0), maxTop());
    };

    let pinnedTop = currentTop();
    const release = () => {
      pinned.current = false;
    };
    // Scrolling away from the latest message hands control back to the person.
    // This is read from the position because wheel and touch events over an
    // email iframe stay inside the iframe and never reach this container. It is
    // checked before every forced scroll too, since a resize can land before
    // the scroll event does. Landing on the very end is the browser clamping
    // the position after a resize, so it does not count.
    const noticeScroll = () => {
      const top = currentTop();
      nearBottom.current = maxTop() - top <= NEAR_BOTTOM_PX;
      if (pinned.current && Math.abs(top - pinnedTop) > 1 && top < maxTop() - 1)
        release();
    };
    const anchor = () => {
      noticeScroll();
      if (!pinned.current) return;
      const top = targetTop();
      container.scrollTop = top;
      pinnedTop = currentTop();
      nearBottom.current = maxTop() - pinnedTop <= NEAR_BOTTOM_PX;
    };
    anchorRef.current = anchor;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      ) {
        release();
      }
    };

    container.addEventListener("scroll", noticeScroll, { passive: true });
    // Clicking in the conversation (showing quoted text, opening a menu) or
    // scrolling with the keyboard also hands control back.
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("pointerdown", release);

    // Content growing (iframes resizing, images loading) or the container
    // changing size (the composer growing) keeps the latest message in place.
    const observer = new ResizeObserver(anchor);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);

    anchor();
    return () => {
      anchorRef.current = () => {};
      observer.disconnect();
      container.removeEventListener("scroll", noticeScroll);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("pointerdown", release);
    };
  }, [containerRef, ready, resetKey]);

  // A new message or note is brought into place when the person is at the end.
  useEffect(() => {
    const container = containerRef.current;
    if (!ready || !container) return;
    if (
      entryCount > lastCount.current &&
      lastCount.current > 0 &&
      nearBottom.current
    ) {
      pinned.current = true;
    }
    lastCount.current = entryCount;
    if (pinned.current) anchorRef.current();
  }, [containerRef, entryCount, ready]);
}
