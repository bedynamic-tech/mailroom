import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchCatchAllAddresses, fetchDomains, fetchMailboxes, setDomainCatchAll, unblockRecipient } from "../api";
import { formatTime } from "../lib";
import type { CatchAllAddress, Domain, Mailbox } from "../../shared/types";
import { BlockAddressDialog, CreateInboxFromAddressDialog } from "./CatchAllDialogs";
import { MailIcon, PlusIcon, ShieldBanIcon } from "./Icons";
import { SettingsBlock, SettingsPanel } from "./SettingsNavigation";

const OFF = "off";

/** Chooses, for each Domain, the Inbox that receives mail for addresses without their own Inbox. */
export function CatchAllSettings(props: { onOpenInbox: (id: number) => void }) {
  // The row a dialog acts on stays set while the dialog animates closed.
  const [creating, setCreating] = useState<CatchAllAddress | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [blocking, setBlocking] = useState("");
  const [blockOpen, setBlockOpen] = useState(false);
  const domains = useQuery({ queryKey: ["domains"], queryFn: fetchDomains });
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes });

  const withInboxes = (domains.data ?? []).filter(
    (domain) => domain.status === "active" && domain.inbox_count > 0,
  );

  return (
    <SettingsBlock
      id="catch-all-heading"
      title="Catch-all"
      description="Collect mail sent to any address on a domain that doesn’t have its own inbox, such as a different address for each service you sign up to. Replies go out from the address the mail was sent to."
    >
      <SettingsPanel>
        {domains.isLoading || mailboxes.isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">Loading…</p>
        ) : domains.isError || mailboxes.isError ? (
          <p className="px-4 py-6 text-sm text-destructive sm:px-5" role="alert">
            Couldn’t load your domains.
          </p>
        ) : withInboxes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
            Add an inbox first. Each domain with an inbox can have a catch-all.
          </p>
        ) : (
          <ul className="divide-y">
            {withInboxes.map((domain) => (
              <DomainCatchAll
                key={domain.id}
                domain={domain}
                inboxes={(mailboxes.data ?? []).filter((mailbox) => mailbox.domain_id === domain.id)}
                onCreateInbox={(row) => {
                  setCreating(row);
                  setCreateOpen(true);
                }}
                onBlock={(address) => {
                  setBlocking(address);
                  setBlockOpen(true);
                }}
              />
            ))}
          </ul>
        )}
      </SettingsPanel>

      <CreateInboxFromAddressDialog
        open={createOpen}
        address={creating?.address ?? ""}
        conversationCount={creating?.conversation_count}
        onOpenChange={setCreateOpen}
        onCreated={(created) => props.onOpenInbox(created.id)}
      />
      <BlockAddressDialog open={blockOpen} address={blocking} onOpenChange={setBlockOpen} />
    </SettingsBlock>
  );
}

function DomainCatchAll(props: {
  domain: Domain;
  inboxes: Mailbox[];
  onCreateInbox: (row: CatchAllAddress) => void;
  onBlock: (address: string) => void;
}) {
  const queryClient = useQueryClient();
  const { domain } = props;
  const selectId = `catch-all-${domain.id}`;

  const choose = useMutation({
    mutationFn: (mailboxId: number | null) => setDomainCatchAll(domain.id, mailboxId),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["domains"] }),
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
      ]),
  });

  const catchAllId = choose.isPending ? choose.variables : domain.catch_all_mailbox_id;

  const addresses = useQuery({
    queryKey: ["catch-all-addresses", catchAllId],
    queryFn: () => fetchCatchAllAddresses(catchAllId!),
    enabled: catchAllId !== null,
  });

  const unblock = useMutation({
    mutationFn: unblockRecipient,
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["catch-all-addresses"] }),
        queryClient.invalidateQueries({ queryKey: ["blocked-recipients"] }),
      ]),
  });

  const caught = catchAllId !== null ? (addresses.data ?? []) : [];

  return (
    <li>
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
        <div className="min-w-0 flex-1">
          <label htmlFor={selectId} className="text-sm font-medium text-foreground">
            {domain.name}
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {catchAllId === null
              ? "Mail to addresses without an inbox is rejected."
              : "Mail to any other address on this domain goes to the chosen inbox."}
          </p>
          {choose.isError && (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {choose.error instanceof Error ? choose.error.message : "Couldn’t update the catch-all."}
            </p>
          )}
        </div>
        <Select
          value={catchAllId === null ? OFF : String(catchAllId)}
          onValueChange={(value) => choose.mutate(value === OFF ? null : Number(value))}
          disabled={choose.isPending}
        >
          <SelectTrigger id={selectId} className="w-full shrink-0 sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OFF}>Off</SelectItem>
            {props.inboxes.map((inbox) => (
              <SelectItem key={inbox.id} value={String(inbox.id)}>
                Deliver to {inbox.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {catchAllId !== null && (
        <>
          <p className="border-t bg-muted/30 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
            In Cloudflare, open Email Routing for {domain.name}. Under Routing rules, set the
            Catch-all address action to <span className="font-medium text-foreground">Send to a Worker</span>{" "}
            and choose this Worker. Addresses with their own inbox keep working as before.
          </p>
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
                      <Button variant="outline" size="sm" onClick={() => props.onCreateInbox(row)}>
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
                          onClick={() => props.onBlock(row.address)}
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
        </>
      )}
    </li>
  );
}
