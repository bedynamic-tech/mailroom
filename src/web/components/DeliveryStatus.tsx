import { useRef, useState, type PointerEvent } from "react";
import { Check, CircleAlert } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import type { MessageBounce } from "../../shared/types";

/**
 * Shown on an outbound Message. Mailroom only stores an outbound Message once
 * the email provider has accepted it, so it reads as sent until a bounce
 * notice comes back for one of its recipients. Then it shows an exclamation
 * mark; hovering it, or tapping it on a phone, shows each bounce message.
 */
export function DeliveryStatus({ bounces }: { bounces: MessageBounce[] }) {
  if (bounces.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:text-xs">
        <Check aria-hidden="true" className="size-3.5" />
        Sent
      </span>
    );
  }
  return <BouncedStatus bounces={bounces} />;
}

function BouncedStatus({ bounces }: { bounces: MessageBounce[] }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  // Hover opens it with a mouse; a short delay lets the pointer reach the card.
  const hoverOpen = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setOpen(true);
  };
  const hoverClose = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };
  const label = bounces.length === 1
    ? `Bounced for ${bounces[0].recipient}`
    : `Bounced for ${bounces.length} recipients`;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs"
        >
          <CircleAlert aria-hidden="true" className="size-3.5" />
          Bounced
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="top"
          sideOffset={4}
          collisionPadding={16}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-popover p-3 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <ul className="space-y-2.5">
            {bounces.map((bounce) => (
              <li key={bounce.recipient} className="min-w-0">
                <p className="font-medium break-all text-foreground">
                  {bounce.recipient}
                  {bounce.status && <span className="ml-1.5 font-normal text-muted-foreground">{bounce.status}</span>}
                </p>
                <p className="mt-0.5 break-words text-muted-foreground">
                  {bounce.diagnostic || "The receiving server rejected this email."}
                </p>
              </li>
            ))}
          </ul>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
