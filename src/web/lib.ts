const AVATAR_COLORS = [
  "bg-[oklch(0.935_0.018_265)] text-[oklch(0.42_0.06_265)]",
  "bg-[oklch(0.935_0.02_200)] text-[oklch(0.42_0.05_200)]",
  "bg-[oklch(0.935_0.022_305)] text-[oklch(0.43_0.07_305)]",
  "bg-[oklch(0.94_0.022_70)] text-[oklch(0.45_0.06_60)]",
];

export function avatarClass(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initialOf(nameOrAddress: string): string {
  return (nameOrAddress.trim()[0] ?? "?").toUpperCase();
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export { splitQuotedTail } from "../shared/quote";
