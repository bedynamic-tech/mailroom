import { useSyncExternalStore } from "react";

/** iOS body text at the default Dynamic Type setting. */
const IOS_BODY_SIZE = 17;

const listeners = new Set<() => void>();
let rootSize = 16;

/**
 * The device's own text scaling. Browsers on desktop and Android already
 * carry it in the default font size the app's rem sizes build on. iOS keeps
 * that at 16px and exposes its Text Size (Dynamic Type) setting only through
 * the system body font, so it is measured here.
 */
function deviceScale(): number {
  if (!CSS.supports("-webkit-touch-callout", "none") || !CSS.supports("font", "-apple-system-body")) return 1;
  const probe = document.createElement("span");
  probe.style.font = "-apple-system-body";
  document.documentElement.append(probe);
  const size = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return size > 0 ? size / IOS_BODY_SIZE : 1;
}

function apply() {
  const root = document.documentElement;
  const scale = deviceScale();
  root.style.fontSize = scale === 1 ? "" : `${scale * 100}%`;
  rootSize = parseFloat(getComputedStyle(root).fontSize) || 16;
}

/** Scales the app with the device's text size and follows changes to it. */
export function startTextSize(): void {
  if (typeof window === "undefined") return;
  apply();
  // iOS sends no event when Text Size changes in Settings; check on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const before = rootSize;
    apply();
    if (rootSize !== before) listeners.forEach((listener) => listener());
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The root font size in pixels, which follows the device's text size. */
export function useRootFontSize(): number {
  return useSyncExternalStore(subscribe, () => rootSize, () => 16);
}
