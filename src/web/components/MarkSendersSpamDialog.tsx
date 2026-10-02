import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { BulkBlockSenderResult } from "../../shared/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { blockThreadSenders } from "../api";
import { OptionGroup } from "./BlockSenderDialog";

type Scope = "inbox" | "all";

/**
 * Confirms marking the senders of the selected Conversations as spam: each
 * one's sender is blocked by address and their open Conversations archived.
 */
export function MarkSendersSpamDialog(props: {
  open: boolean;
  ids: number[];
  onOpenChange: (open: boolean) => void;
  onMarked: (result: BulkBlockSenderResult) => void;
}) {
  const [scope, setScope] = useState<Scope>("inbox");
  const mark = useMutation({
    mutationFn: () => blockThreadSenders(props.ids, scope),
    onSuccess: props.onMarked,
  });

  const { reset } = mark;
  // Each opening starts fresh, with the narrowest block preselected.
  useEffect(() => {
    if (!props.open) return;
    reset();
    setScope("inbox");
  }, [props.open, reset]);

  const count = props.ids.length;
  const many = count !== 1;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!mark.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!mark.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{many ? "Mark senders as spam?" : "Mark sender as spam?"}</DialogTitle>
          <DialogDescription>
            {many
              ? `The sender of each of the ${count} selected conversations is blocked by address.`
              : "The sender of the selected conversation is blocked by address."}{" "}
            Blocked mail is rejected before it reaches Mailroom +. You can unblock under
            Settings → Spam.
          </DialogDescription>
        </DialogHeader>

        <OptionGroup
          legend="Block on"
          name="mark-spam-scope"
          value={scope}
          disabled={mark.isPending}
          onChange={setScope}
          options={[
            {
              value: "inbox",
              label: many ? "Each conversation’s inbox" : "This conversation’s inbox",
              hint: "Only the inbox the mail came to",
            },
            { value: "all", label: "All inboxes", hint: "Every inbox in this workspace" },
          ]}
        />

        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-5 text-foreground">
          {many ? "These conversations" : "This conversation"} and the{" "}
          {many ? "senders’" : "sender’s"} other open conversations there will be archived.
        </p>

        {mark.isError && (
          <p className="text-sm text-destructive" role="alert">
            {mark.error instanceof Error ? mark.error.message : "Couldn’t mark as spam"}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={mark.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => mark.mutate()}
            disabled={mark.isPending || count === 0}
          >
            {mark.isPending ? "Marking…" : "Mark as spam"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
