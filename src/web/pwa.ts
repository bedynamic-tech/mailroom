import { useEffect, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { syncBrowserNotifications } from "./api";
import { currentBrowserPushSubscription } from "./push-notifications";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  standalone?: boolean;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/**
 * Registers the service worker as soon as the app loads so the browser can
 * offer installation and the app shell opens offline. Push subscriptions reuse
 * this same registration.
 */
export function startPwa(queryClient: QueryClient): void {
  if (typeof window === "undefined") return;
  installed = isStandalone();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installed = true;
    emit();
  });

  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(() => resyncPushSubscription())
    .catch((error) => {
      console.warn("Service worker registration failed", error);
    });
  // A push arrived while the app is open: refresh lists without waiting for polling.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type !== "mailroom:new-email") return;
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  });
}

// The server can forget a subscription this browser still holds, for example
// after notifications were turned off and on from another device. Re-sending
// it is harmless; the server only keeps it while notifications are on.
async function resyncPushSubscription(): Promise<void> {
  try {
    const subscription = await currentBrowserPushSubscription();
    if (subscription) await syncBrowserNotifications(subscription);
  } catch (error) {
    console.warn("Could not re-register this browser for notifications", error);
  }
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as BadgingNavigator).standalone === true
  );
}

/** iPhone and iPad only allow Web Push from a Home Screen app. */
export function isIosBrowser(): boolean {
  const { userAgent, maxTouchPoints } = navigator;
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && !isStandalone();
}

export interface InstallState {
  installed: boolean;
  canPrompt: boolean;
  prompt: () => Promise<void>;
}

const snapshot = () => `${installed}:${deferredPrompt !== null}`;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useInstallState(): InstallState {
  useSyncExternalStore(subscribe, snapshot, snapshot);

  return {
    installed,
    canPrompt: deferredPrompt !== null,
    prompt: async () => {
      const event = deferredPrompt;
      if (!event) return;
      deferredPrompt = null;
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === "accepted") installed = true;
      emit();
    },
  };
}

/** Mirrors the unread total on the app icon and in the window title. */
export function useUnreadBadge(unread: number | null): void {
  useEffect(() => {
    if (unread === null) return;
    document.title = unread > 0 ? `(${unread > 999 ? "999+" : unread}) Mailroom +` : "Mailroom +";
    const nav = navigator as BadgingNavigator;
    const update = unread > 0 ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.();
    update?.catch(() => undefined);
  }, [unread]);
}
