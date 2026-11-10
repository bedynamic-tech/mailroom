import { useEffect, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import type { ForwardedSender } from "../../shared/forwarded-sender";
import { changeThreadContact, restoreThreadContact } from "../api";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";

/**
 * Changes who a Conversation is with: its received email is reassigned to
 * another address, so the list, replies and the agent use that person.
 * Meant for forwards, so `suggestion` is the original sender found in the
 * forwarded email, offered with one tap.
 */
export function ChangeContactDialog(props: {
  open: boolean;
  threadId: number;
  /** Who the Conversation is with now, as shown in the list. */
  current: { address: string; name: string };
  suggestion: ForwardedSender | null;
  /** The sender the email arrived with, when it was reassigned before. */
  original: { address: string; name: string | null } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [addresses, setAddresses] = useState<string[]>([]);
  const [name, setName] = useState("");
  const addressField = useRef<RecipientInputHandle>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
    void queryClient.invalidateQueries({ queryKey: ["threads"] });
    props.onOpenChange(false);
  };
  const change = useMutation({
    mutationFn: (input: { address: string; name: string | null }) =>
      changeThreadContact(props.threadId, input.address, input.name),
    onSuccess: refresh,
  });
  const restore = useMutation({
    mutationFn: () => restoreThreadContact(props.threadId),
    onSuccess: refresh,
  });
  const pending = change.isPending || restore.isPending;
  const error = change.error ?? restore.error;

  const { reset: resetChange } = change;
  const { reset: resetRestore } = restore;
  // Each opening starts empty, so a half-typed address from last time is not saved by mistake.
  useEffect(() => {
    if (!props.open) return;
    resetChange();
    resetRestore();
    setAddresses([]);
    setName("");
  }, [props.open, resetChange, resetRestore]);

  const save = () => {
    const committed = addressField.current ? addressField.current.commit() : addresses;
    const address = committed?.[0];
    if (!address) return;
    change.mutate({ address, name: name.trim() || null });
  };

  const suggestion =
    props.suggestion && props.suggestion.address !== props.current.address.toLowerCase()
      ? props.suggestion
      : null;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!pending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!pending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change contact</DialogTitle>
          <DialogDescription>
            Choose who this conversation is with. The list shows their name and replies go to
            them.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm leading-5 text-foreground">
          Now with <span className="font-medium break-all">{props.current.name}</span>
          {props.current.name !== props.current.address && (
            <span className="break-all text-muted-foreground"> ({props.current.address})</span>
          )}
        </p>

        {suggestion && (
          <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Original sender of the forwarded email</p>
              <p className="truncate text-sm font-medium text-foreground">
                {suggestion.name ?? suggestion.address}
              </p>
              {suggestion.name && (
                <p className="truncate text-xs text-muted-foreground">{suggestion.address}</p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => change.mutate({ address: suggestion.address, name: suggestion.name })}
            >
              Use
            </Button>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label htmlFor="change-contact-address" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {suggestion ? "Or someone else" : "Email address"}
            </label>
            <div className="rounded-lg border border-input px-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <RecipientInput
                ref={addressField}
                id="change-contact-address"
                label="Email address"
                values={addresses}
                onChange={setAddresses}
                capacity={1 - addresses.length}
                disabled={pending}
                placeholder="Name or email"
                onSubmitShortcut={save}
              />
            </div>
          </div>
          <div>
            <label htmlFor="change-contact-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Name (optional)
            </label>
            <Input
              id="change-contact-name"
              value={name}
              maxLength={200}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              A saved contact’s name is shown instead, when there is one.
            </p>
          </div>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error instanceof Error ? error.message : "Couldn’t change the contact"}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          {props.original ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground"
              disabled={pending}
              onClick={() => restore.mutate()}
              title={props.original.address}
            >
              {restore.isPending ? "Restoring…" : "Restore original sender"}
            </Button>
          ) : (
            <span className="hidden sm:block" />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" disabled={pending} onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={save}>
              {change.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
