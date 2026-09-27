import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { domainOf, isSharedMailDomain } from "../../shared/blocked-senders";
import { reportSpam } from "../api";

type BlockScope = "address" | "domain" | "none";

/** Reports a Conversation as spam, optionally blocking its sender's address or domain. */
export function ReportSpamDialog(props: {
  open: boolean;
  threadId: number;
  sender: string;
  onOpenChange: (open: boolean) => void;
  onReported: () => void;
}) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<BlockScope>("address");
  const domain = domainOf(props.sender);
  const sharedDomain = isSharedMailDomain(domain);
  const report = useMutation({
    mutationFn: () => reportSpam(props.threadId, scope),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      queryClient.invalidateQueries({ queryKey: ["blocked-senders"] });
      props.onOpenChange(false);
      props.onReported();
    },
  });

  const { reset } = report;
  // Each opening starts fresh, with the least disruptive block preselected.
  useEffect(() => {
    if (!props.open) return;
    reset();
    setScope("address");
  }, [props.open, props.threadId, reset]);

  const options: Array<{ value: BlockScope; label: string; hint: string; disabled?: boolean }> = [
    {
      value: "address",
      label: `Block ${props.sender}`,
      hint: "Rejects future mail from this address.",
    },
    {
      value: "domain",
      label: `Block everyone at ${domain}`,
      hint: sharedDomain
        ? `${domain} is a public email provider, so it can’t be blocked as a whole.`
        : "Rejects future mail from this domain and its subdomains.",
      disabled: sharedDomain,
    },
    { value: "none", label: "Don’t block", hint: "Only archives this conversation." },
  ];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!report.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!report.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Report spam</DialogTitle>
          <DialogDescription>
            Reporting archives this conversation. When you block the sender, their other
            open conversations are archived too. Manage blocked senders under Settings → Spam.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-1.5" disabled={report.isPending}>
          <legend className="sr-only">What to block</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                scope === option.value ? "border-foreground/40 bg-muted/60" : "hover:bg-muted/40",
                option.disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
              )}
            >
              <input
                type="radio"
                name="spam-block-scope"
                value={option.value}
                checked={scope === option.value}
                disabled={option.disabled}
                onChange={() => setScope(option.value)}
                className="mt-1 accent-foreground"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {option.label}
                </span>
                <span className="block text-xs leading-5 text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {report.isError && (
          <p className="text-sm text-destructive" role="alert">
            {report.error instanceof Error ? report.error.message : "Couldn’t report this conversation"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={report.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => report.mutate()}
            disabled={report.isPending}
          >
            {report.isPending ? "Reporting…" : "Report spam"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
