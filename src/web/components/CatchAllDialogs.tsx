import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { blockRecipient, createInboxFromCatchAll } from "../api";
import type { Mailbox } from "../../shared/types";

/**
 * Confirms turning an address the catch-all received mail for into its own
 * Inbox, optionally moving the Conversations already caught for it.
 */
export function CreateInboxFromAddressDialog(props: {
  open: boolean;
  address: string;
  /** How many Conversations the catch-all holds for the address, when known. */
  conversationCount?: number;
  onOpenChange: (open: boolean) => void;
  onCreated?: (mailbox: Mailbox) => void;
}) {
  const queryClient = useQueryClient();
  const [move, setMove] = useState(true);
  const create = useMutation({
    mutationFn: () => createInboxFromCatchAll({ address: props.address, moveConversations: move }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["domains"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["thread"] }),
        queryClient.invalidateQueries({ queryKey: ["catch-all-addresses"] }),
        queryClient.invalidateQueries({ queryKey: ["blocked-recipients"] }),
      ]);
      props.onOpenChange(false);
      props.onCreated?.(result.mailbox);
    },
  });

  const { reset } = create;
  useEffect(() => {
    if (!props.open) return;
    reset();
    setMove(true);
  }, [props.open, props.address, reset]);

  const count = props.conversationCount;
  const moveLabel =
    count === undefined
      ? "Move the conversations already sent to this address"
      : `Move ${count === 1 ? "its conversation" : `its ${count} conversations`} to the new inbox`;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!create.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!create.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an inbox for this address?</DialogTitle>
          <DialogDescription>
            New mail to <span className="font-medium break-all text-foreground">{props.address}</span>{" "}
            will arrive in its own inbox instead of the catch-all.
          </DialogDescription>
        </DialogHeader>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5">
          <Checkbox
            checked={move}
            disabled={create.isPending}
            onCheckedChange={(checked) => setMove(checked === true)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{moveLabel}</span>
            <span className="block text-xs leading-5 text-muted-foreground">
              Labels from the catch-all don’t carry over.
            </span>
          </span>
        </label>

        {create.isError && (
          <p className="text-sm text-destructive" role="alert">
            {create.error instanceof Error ? create.error.message : "Couldn’t create the inbox"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create inbox"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirms blocking an address so the catch-all rejects mail sent to it. */
export function BlockAddressDialog(props: {
  open: boolean;
  address: string;
  onOpenChange: (open: boolean) => void;
  onBlocked?: () => void;
}) {
  const queryClient = useQueryClient();
  const block = useMutation({
    mutationFn: () => blockRecipient(props.address),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["blocked-recipients"] }),
        queryClient.invalidateQueries({ queryKey: ["catch-all-addresses"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
        queryClient.invalidateQueries({ queryKey: ["thread"] }),
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
      ]);
      props.onOpenChange(false);
      props.onBlocked?.();
    },
  });

  const { reset } = block;
  useEffect(() => {
    if (props.open) reset();
  }, [props.open, props.address, reset]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!block.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!block.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Block this address?</DialogTitle>
          <DialogDescription>
            Mail sent to <span className="font-medium break-all text-foreground">{props.address}</span>{" "}
            will be rejected before it reaches Mailroom +, whoever sends it. Its open conversations
            will be archived. You can unblock it under Settings, Spam.
          </DialogDescription>
        </DialogHeader>

        {block.isError && (
          <p className="text-sm text-destructive" role="alert">
            {block.error instanceof Error ? block.error.message : "Couldn’t block this address"}
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
            disabled={block.isPending}
          >
            {block.isPending ? "Blocking…" : "Block address"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
