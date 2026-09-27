import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { blockSender, fetchBlockedSenders, unblockSender } from "../api";
import { formatTime } from "../lib";
import { ShieldBanIcon, TrashIcon } from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function SpamSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenAi: () => void;
}) {
  const queryClient = useQueryClient();
  const [pattern, setPattern] = useState("");
  const blocked = useQuery({ queryKey: ["blocked-senders"], queryFn: fetchBlockedSenders });
  const add = useMutation({
    mutationFn: blockSender,
    onSuccess: () => {
      setPattern("");
      queryClient.invalidateQueries({ queryKey: ["blocked-senders"] });
    },
  });
  const remove = useMutation({
    mutationFn: unblockSender,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["blocked-senders"] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pattern.trim()) add.mutate(pattern.trim());
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="spam"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenSpam={() => undefined}
        onOpenAi={props.onOpenAi}
      />

      <SettingsPage>
        <SettingsBlock
          id="blocked-senders-heading"
          title="Blocked senders"
          description="Mail from these addresses and domains is rejected before it reaches any inbox. Blocking a domain also blocks its subdomains. Use Report spam on a conversation to block its sender in one step."
        >
          <SettingsPanel>
            <form onSubmit={submit} className="flex flex-col gap-2 border-b px-4 py-4 sm:flex-row sm:px-5">
              <label htmlFor="block-sender-pattern" className="sr-only">
                Email address or domain to block
              </label>
              <Input
                id="block-sender-pattern"
                value={pattern}
                onChange={(event) => {
                  setPattern(event.target.value);
                  if (add.isError) add.reset();
                }}
                placeholder="spammer@example.com or example.com"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={add.isError || undefined}
                aria-describedby={add.isError ? "block-sender-error" : undefined}
              />
              <Button type="submit" disabled={!pattern.trim() || add.isPending} className="shrink-0">
                <ShieldBanIcon className="h-4 w-4" />
                {add.isPending ? "Blocking…" : "Block"}
              </Button>
            </form>
            {add.isError && (
              <p id="block-sender-error" className="border-b px-4 py-2 text-xs text-destructive sm:px-5" role="alert">
                {add.error instanceof Error ? add.error.message : "Couldn’t block this sender"}
              </p>
            )}
            {remove.isError && (
              <p className="border-b px-4 py-2 text-xs text-destructive sm:px-5" role="alert">
                {remove.error instanceof Error ? remove.error.message : "Couldn’t unblock this sender"}
              </p>
            )}

            {blocked.isLoading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">Loading…</p>
            ) : blocked.isError ? (
              <p className="px-4 py-6 text-sm text-destructive sm:px-5" role="alert">
                Couldn’t load blocked senders.
              </p>
            ) : blocked.data?.length ? (
              <ul className="divide-y">
                {blocked.data.map((rule) => (
                  <li key={rule.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground" title={rule.pattern}>
                        {rule.kind === "domain" ? `@${rule.pattern}` : rule.pattern}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {rule.kind === "domain" ? "Domain and subdomains" : "Address"}
                        {" · "}
                        {rule.blocked_count === 0
                          ? "Nothing blocked yet"
                          : `${rule.blocked_count.toLocaleString()} ${rule.blocked_count === 1 ? "email" : "emails"} blocked`}
                        {rule.last_blocked_at && `, last ${formatTime(rule.last_blocked_at)}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove.mutate(rule.id)}
                      disabled={remove.isPending && remove.variables === rule.id}
                      aria-label={`Unblock ${rule.pattern}`}
                      className="shrink-0 text-muted-foreground"
                    >
                      <TrashIcon className="h-4 w-4" />
                      <span className="hidden sm:inline">Unblock</span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
                No senders are blocked.
              </p>
            )}
          </SettingsPanel>
        </SettingsBlock>
      </SettingsPage>
    </div>
  );
}
