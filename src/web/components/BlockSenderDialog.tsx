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

export type BlockKind = "address" | "domain";

export interface BlockScopeOption {
  value: string;
  /** Shown as the option's title. */
  label: string;
  hint: string;
  /** How the confirmation names this scope: "support@acme.com" or "any of your inboxes". */
  target: string;
}

/**
 * Confirms blocking a sender, by address or by domain, on one of `scopes`.
 * `onBlock` performs the block; `archives` says whether it also archives the
 * sender's open conversations, so the confirmation can say so.
 */
export function BlockSenderDialog(props: {
  open: boolean;
  sender: string;
  scopes: BlockScopeOption[];
  archives: boolean;
  onBlock: (kind: BlockKind, scope: string) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
  onBlocked?: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<BlockKind>("address");
  const [scope, setScope] = useState(props.scopes[0]?.value ?? "");
  const domain = domainOf(props.sender);
  const sharedDomain = isSharedMailDomain(domain);
  const block = useMutation({
    mutationFn: () => props.onBlock(kind, scope),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocked-senders"] });
      props.onOpenChange(false);
      props.onBlocked?.();
    },
  });

  const { reset } = block;
  const firstScope = props.scopes[0]?.value ?? "";
  // Each opening starts fresh, with the narrowest block preselected.
  useEffect(() => {
    if (!props.open) return;
    reset();
    setKind("address");
    setScope(firstScope);
  }, [props.open, props.sender, firstScope, reset]);

  const blockedWho = kind === "domain" ? `everyone at ${domain}` : props.sender;
  const blockedWhere = props.scopes.find((option) => option.value === scope)?.target ?? "";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!block.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!block.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Block sender?</DialogTitle>
          <DialogDescription>
            Blocked mail is rejected before it reaches Mailroom +. You can unblock under
            Settings → Spam.
          </DialogDescription>
        </DialogHeader>

        <OptionGroup
          legend="Block"
          name="block-sender-kind"
          value={kind}
          disabled={block.isPending}
          onChange={setKind}
          options={[
            { value: "address", label: props.sender, hint: "Only this address" },
            {
              value: "domain",
              label: `Everyone at ${domain}`,
              hint: sharedDomain
                ? `${domain} is a public email provider, so it can’t be blocked as a whole`
                : "This domain and its subdomains",
              disabled: sharedDomain,
            },
          ]}
        />

        <OptionGroup
          legend="On"
          name="block-sender-scope"
          value={scope}
          disabled={block.isPending}
          onChange={setScope}
          options={props.scopes}
        />

        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-5 text-foreground">
          Mail from <span className="font-medium break-all">{blockedWho}</span> to{" "}
          <span className="font-medium break-all">{blockedWhere}</span> will be rejected.{" "}
          {props.archives
            ? "This conversation and their other open conversations there will be archived."
            : "Existing conversations stay where they are."}
        </p>

        {block.isError && (
          <p className="text-sm text-destructive" role="alert">
            {block.error instanceof Error ? block.error.message : "Couldn’t block this sender"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={block.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => block.mutate()}
            disabled={block.isPending || !scope}
          >
            {block.isPending ? "Blocking…" : "Block sender"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionGroup<T extends string>(props: {
  legend: string;
  name: string;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; hint: string; disabled?: boolean }>;
}) {
  return (
    <fieldset className="space-y-1.5" disabled={props.disabled}>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{props.legend}</legend>
      {props.options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors",
            props.value === option.value ? "border-foreground/40 bg-muted/60" : "hover:bg-muted/40",
            option.disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
          )}
        >
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            disabled={option.disabled}
            onChange={() => props.onChange(option.value)}
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
  );
}
