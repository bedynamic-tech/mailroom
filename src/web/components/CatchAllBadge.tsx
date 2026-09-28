import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Marks mail the catch-all received for an address without its own inbox. */
export function CatchAllBadge(props: { address: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      title={`Sent to ${props.address} through the catch-all`}
      className={cn(
        "h-5 shrink-0 rounded-md border-amber-300 bg-amber-50 px-1.5 text-xs font-medium text-amber-800",
        "dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300",
        props.className,
      )}
    >
      Catch-all
    </Badge>
  );
}
