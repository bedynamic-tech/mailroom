import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fetchCatchAllAddresses, setCatchAll, unblockRecipient } from "../api";
import { formatTime } from "../lib";
import type { CatchAllAddress, Domain, Mailbox } from "../../shared/types";
import { BlockAddressDialog, CreateInboxFromAddressDialog } from "./CatchAllDialogs";
import { MailIcon, PlusIcon, ShieldBanIcon } from "./Icons";
import { SettingsBlock, SettingsPanel } from "./SettingsNavigation";

/** Turns an Inbox into its Domain's catch-all and manages the addresses it has caught. */
export function CatchAllSettings(props: {
  mailbox: Mailbox;
  mailboxes: Mailbox[];
  domains: Domain[];
  onOpenInbox: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  // The row a dialog acts on stays set while the dialog animates closed.
  const [creating, setCreating] = useState<CatchAllAddress | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [blocking, setBlocking] = useState("");
  const [blockOpen, setBlockOpen] = useState(false);
  const { mailbox } = props;
  const domain = props.domains.find((item) => item.id === mailbox.domain_id);
  const domainName = domain?.name ?? mailbox.address.slice(mailbox.address.lastIndexOf("@") + 1);
  const otherCatchAll =
    domain?.catch_all_mailbox_id && domain.catch_all_mailbox_id !== mailbox.id
      ? props.mailboxes.find((item) => item.id === domain.catch_all_mailbox_id)
      : undefined;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setCatchAll(mailbox.id, enabled),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["domains"] }),
      ]),
  });

  const addresses = useQuery({
    queryKey: ["catch-all-addresses", mailbox.id],
    queryFn: () => fetchCatchAllAddresses(mailbox.id),
  });

  const unblock = useMutation({
    mutationFn: unblockRecipient,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catch-all-addresses"] }),
        queryClient.invalidateQueries({ queryKey: ["blocked-recipients"] }),
      ]),
  });

  const enabled = toggle.isPending ? toggle.variables : mailbox.is_catch_all;
  const caught = addresses.data ?? [];

  return (
    <SettingsBlock
      id="catch-all-heading"
      title="Catch-all"
      description={`Collect mail sent to any address on ${domainName} that doesn’t have its own inbox, such as a different address for each service you sign up to.`}
    >
      <SettingsPanel>
        <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <label htmlFor="catch-all" className="text-sm font-medium text-foreground">
              Receive mail for any address on {domainName}
            </label>
            <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              Each conversation shows the address it was sent to, and replies go out from that
              address.
              {otherCatchAll && !enabled && (
                <> {otherCatchAll.address} is the catch-all now. Turning this on replaces it.</>
              )}
            </p>
            {toggle.isError && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {toggle.error instanceof Error ? toggle.error.message : "Couldn’t update the catch-all."}
              </p>
            )}
          </div>
          <Switch
            id="catch-all"
            checked={enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            className="mt-0.5"
          />
        </div>

        {enabled && (
          <p className="border-t bg-muted/30 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
            In Cloudflare, open Email Routing for {domainName}. Under Routing rules, set the
            Catch-all address action to <span className="font-medium text-foreground">Send to a Worker</span>{" "}
            and choose this Worker. Addresses with their own inbox keep working as before.
          </p>
        )}

        {(enabled || caught.length > 0) && (
          <div className="border-t">
            <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground sm:px-5">
              Addresses received
            </p>
            {addresses.isLoading ? (
              <p className="px-4 py-4 text-sm text-muted-foreground sm:px-5">Loading…</p>
            ) : addresses.isError ? (
              <p className="px-4 py-4 text-sm text-destructive sm:px-5" role="alert">
                Couldn’t load the addresses.
              </p>
            ) : caught.length === 0 ? (
              <p className="flex items-center gap-2 px-4 pt-1 pb-4 text-sm text-muted-foreground sm:px-5">
                <MailIcon className="h-4 w-4" />
                No mail caught yet
              </p>
            ) : (
              <ul className="divide-y">
                {caught.map((row) => (
                  <li
                    key={row.address}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground" title={row.address}>
                        {row.address}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row.blocked_id !== null ? "Blocked · " : ""}
                        {row.conversation_count.toLocaleString()}{" "}
                        {row.conversation_count === 1 ? "conversation" : "conversations"}
                        {row.unread_count > 0 && `, ${row.unread_count.toLocaleString()} unread`}
                        {`, last ${formatTime(row.last_message_at)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="outline" size="sm" onClick={() => {
                          setCreating(row);
                          setCreateOpen(true);
                        }}>
                        <PlusIcon className="h-3.5 w-3.5" />
                        Create inbox
                      </Button>
                      {row.blocked_id !== null ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => unblock.mutate(row.blocked_id!)}
                          disabled={unblock.isPending && unblock.variables === row.blocked_id}
                        >
                          Unblock
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => {
                            setBlocking(row.address);
                            setBlockOpen(true);
                          }}
                        >
                          <ShieldBanIcon className="h-3.5 w-3.5" />
                          Block
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsPanel>

      <CreateInboxFromAddressDialog
        open={createOpen}
        address={creating?.address ?? ""}
        conversationCount={creating?.conversation_count}
        onOpenChange={setCreateOpen}
        onCreated={(created) => props.onOpenInbox(created.id)}
      />
      <BlockAddressDialog
        open={blockOpen}
        address={blocking}
        onOpenChange={setBlockOpen}
      />
    </SettingsBlock>
  );
}
