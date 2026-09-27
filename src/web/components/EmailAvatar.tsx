import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { avatarClass, initialOf } from "../lib";

export function EmailAvatar({
  email,
  label,
  fallback,
  className,
}: {
  email?: string | null;
  label: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  const hasEmailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const avatarUrl = hasEmailAddress
    ? `https://unavatar.io/email/${encodeURIComponent(normalizedEmail)}?fallback=false`
    : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        avatarClass(normalizedEmail || label),
        className,
      )}
    >
      {fallback ?? initialOf(label)}
      {avatarUrl && failedUrl !== avatarUrl && (
        <img
          src={avatarUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      )}
    </span>
  );
}
