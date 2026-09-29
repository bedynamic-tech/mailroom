import { Check } from "lucide-react";

/**
 * Shown on an outbound Message. Mailroom only stores an outbound Message once
 * the email provider has accepted it, so every stored one reads as sent.
 * Bounces are not tracked yet.
 */
export function DeliveryStatus() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:text-xs">
      <Check aria-hidden="true" className="size-3.5" />
      Sent
    </span>
  );
}
