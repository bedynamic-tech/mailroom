import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

/**
 * Shown on an outbound Message. Mailroom only stores an outbound Message once
 * the email provider has accepted it, so every stored one reads as sent.
 * Bounces are not tracked yet. Hovering (or tapping, on touch screens) lists
 * every address it went to.
 */
export function DeliveryStatus(props: { to: string[]; cc: string[]; bcc: string[] }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const groups = [
    { label: "To", addresses: props.to },
    { label: "Cc", addresses: props.cc },
    { label: "Bcc", addresses: props.bcc },
  ].filter((group) => group.addresses.length > 0);
  const count = groups.reduce((total, group) => total + group.addresses.length, 0);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Hover only for a mouse; touch opens and closes on tap via the trigger's click.
  const hoverOpen = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(closeTimer.current);
    hovering.current = true;
    setOpen(true);
  };
  const hoverClose = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(closeTimer.current);
    hovering.current = false;
    // A short grace period lets the pointer cross from the indicator to the list.
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      // A mouse click on the indicator while hovering keeps the list open.
      onOpenChange={(next) => (next || !hovering.current) && setOpen(next)}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          aria-label={`Sent to ${count} ${count === 1 ? "address" : "addresses"}`}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-xs touch:py-1"
        >
          <Check aria-hidden="true" className="size-3.5" />
          Sent
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          side="top"
          sideOffset={4}
          collisionPadding={16}
          onPointerEnter={hoverOpen}
          onPointerLeave={hoverClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="z-50 w-max max-w-[min(22rem,calc(100vw-2rem))] rounded-lg bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <div className="mb-1.5 font-medium text-foreground">Sent to</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {groups.map((group) => (
              <div key={group.label} className="contents">
                <dt className="text-muted-foreground">{group.label}</dt>
                <dd className="min-w-0">
                  {group.addresses.map((address) => (
                    <div key={address} className="break-all">
                      {address}
                    </div>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
