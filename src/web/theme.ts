import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";

// index.html reads the same key before the app loads, so the first paint
// already uses the saved theme.
const THEME_KEY = "mailroom.theme";
const THEME_COLORS = { light: "#ffffff", dark: "#111315" } as const;

const listeners = new Set<() => void>();
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function readChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = typeof window === "undefined" ? "system" : readChoice();

function resolved(): "light" | "dark" {
  if (choice !== "system") return choice;
  return darkQuery().matches ? "dark" : "light";
}

function apply() {
  const theme = resolved();
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  // The system theme-color tags carry media queries; an explicit choice
  // overrides both so the installed app's title bar matches.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = choice === "system" ? THEME_COLORS[meta.dataset.theme as "light" | "dark"] : THEME_COLORS[theme];
  });
}

/** Applies the saved theme and follows the operating system while set to System. */
export function startTheme(): void {
  if (typeof window === "undefined") return;
  apply();
  darkQuery().addEventListener("change", () => {
    if (choice === "system") apply();
  });
  // Another tab changed the theme.
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY) return;
    choice = readChoice();
    apply();
    listeners.forEach((listener) => listener());
  });
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  apply();
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice, () => "system" as const);
}
