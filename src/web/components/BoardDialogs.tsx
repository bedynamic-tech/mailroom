import { useEffect, useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createBoardCard,
  deleteBoardCard,
  fetchBoard,
  linkBoardCard,
  moveBoardCard,
  unlinkBoardCard,
  updateBoardCard,
} from "../api";
import {
  MAX_BOARD_CARD_DESCRIPTION_LENGTH,
  MAX_BOARD_CARD_TITLE_LENGTH,
} from "../../shared/board";
import type { BoardCard, BoardCardConversation } from "../../shared/types";
import { ArchiveIcon, MailIcon, SearchIcon, XIcon } from "./Icons";

/** Refreshes everything that shows Board Cards or their links. */
export function useInvalidateBoard() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["board"] }),
      queryClient.invalidateQueries({ queryKey: ["thread"] }),
      queryClient.invalidateQueries({ queryKey: ["threads"] }),
    ]);
}

export type CardDialogTarget =
  | { kind: "edit"; cardId: number }
  | {
      kind: "create";
      columnId?: number;
      title?: string;
      conversation?: BoardCardConversation;
    };

/**
 * Creates a Board Card, or edits one: its title, description, column and the
 * Conversations it links.
 */
export function BoardCardDialog(props: {
  target: CardDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onOpenConversation?: (conversation: BoardCardConversation) => void;
  onCreated?: (card: BoardCard) => void;
}) {
  const invalidate = useInvalidateBoard();
  const board = useQuery({ queryKey: ["board"], queryFn: fetchBoard, enabled: props.target !== null });
  const titleId = useId();
  const descriptionId = useId();
  const target = props.target;
  const card =
    target?.kind === "edit" ? board.data?.cards.find((item) => item.id === target.cardId) : undefined;
  const columns = board.data?.columns ?? [];

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState<number | null>(null);
  const [linked, setLinked] = useState<BoardCardConversation[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const targetKey = target
    ? target.kind === "edit"
      ? `edit-${target.cardId}`
      : `create-${target.columnId ?? ""}-${target.conversation?.id ?? ""}-${target.title ?? ""}`
    : null;

  // Fill the form once per opened target, after the board has loaded.
  useEffect(() => {
    if (!target || !targetKey || loadedFor === targetKey || !board.data) return;
    if (target.kind === "edit") {
      if (!card) return;
      setTitle(card.title);
      setDescription(card.description ?? "");
      setColumnId(card.column_id);
      setLinked(card.conversations);
    } else {
      setTitle(target.title ?? "");
      setDescription("");
      setColumnId(target.columnId ?? board.data.columns[0]?.id ?? null);
      setLinked(target.conversation ? [target.conversation] : []);
    }
    setConfirmingDelete(false);
    setLoadedFor(targetKey);
  }, [board.data, card, loadedFor, target, targetKey]);

  useEffect(() => {
    if (!target) setLoadedFor(null);
  }, [target]);

  const save = useMutation({
    mutationFn: async () => {
      if (!target || columnId === null) throw new Error("Choose a column");
      if (target.kind === "create") {
        return createBoardCard({
          column_id: columnId,
          title,
          description,
          thread_ids: linked.map((conversation) => conversation.id),
        });
      }
      if (!card) throw new Error("This item no longer exists");
      const updated = await updateBoardCard(card.id, { title, description });
      if (columnId !== card.column_id) {
        const end = board.data?.cards.filter((item) => item.column_id === columnId).length ?? 0;
        await moveBoardCard(card.id, columnId, end);
      }
      return updated;
    },
    onSuccess: async (saved) => {
      await invalidate();
      if (target?.kind === "create") props.onCreated?.(saved);
      props.onOpenChange(false);
    },
  });

  const unlink = useMutation({
    mutationFn: (threadId: number) => unlinkBoardCard(card!.id, threadId),
    onSuccess: (updated) => {
      setLinked(updated.conversations);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteBoardCard(card!.id),
    onSuccess: async () => {
      await invalidate();
      props.onOpenChange(false);
    },
  });

  const { reset: resetSave } = save;
  const { reset: resetRemove } = remove;
  useEffect(() => {
    resetSave();
    resetRemove();
  }, [targetKey, resetSave, resetRemove]);

  const busy = save.isPending || remove.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && !busy) save.mutate();
  };
  const missing = target?.kind === "edit" && board.isSuccess && !card;
  const error = save.error ?? remove.error ?? unlink.error;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogContent
        fullScreenOnMobile
        showCloseButton={!busy}
        className="gap-5 sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          if (target?.kind === "edit") event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{target?.kind === "create" ? "New board item" : "Board item"}</DialogTitle>
          <DialogDescription className={target?.kind === "create" ? undefined : "sr-only"}>
            {target?.kind === "create"
              ? "Track this on the board. It stays linked to its conversations."
              : "Edit this item, move it to another column or open its conversations."}
          </DialogDescription>
        </DialogHeader>

        {missing ? (
          <p className="text-sm text-muted-foreground">This item was deleted.</p>
        ) : (
          <form id="board-card-form" onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={titleId} className="text-sm font-medium text-foreground">
                Title
              </label>
              <Input
                id={titleId}
                value={title}
                maxLength={MAX_BOARD_CARD_TITLE_LENGTH}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs doing?"
                disabled={busy}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={descriptionId} className="text-sm font-medium text-foreground">
                Description
              </label>
              <Textarea
                id={descriptionId}
                value={description}
                maxLength={MAX_BOARD_CARD_DESCRIPTION_LENGTH}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Add details (optional)"
                disabled={busy}
                className="min-h-24"
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">Column</span>
              <Select
                value={columnId === null ? "" : String(columnId)}
                onValueChange={(value) => setColumnId(Number(value))}
                disabled={busy || columns.length === 0}
              >
                <SelectTrigger aria-label="Column" className="w-full">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {columns.map((column) => (
                    <SelectItem key={column.id} value={String(column.id)}>
                      {column.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-foreground">Conversations</span>
              {linked.length === 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  None yet. Use “Add to board item” on a message to link one.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {linked.map((conversation) => (
                    <li key={conversation.id} className="flex items-center gap-1 py-1 pr-1 pl-3">
                      <button
                        type="button"
                        onClick={() => props.onOpenConversation?.(conversation)}
                        disabled={!props.onOpenConversation}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm outline-none enabled:hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {conversation.status === "archived" ? (
                          <ArchiveIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <MailIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">
                            {conversation.subject || "(no subject)"}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {conversation.mailbox_address}
                            {conversation.status === "archived" ? " · Archived" : ""}
                          </span>
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
                        aria-label={`Unlink ${conversation.subject || "conversation"}`}
                        title="Unlink"
                        disabled={busy || unlink.isPending}
                        onClick={() =>
                          target?.kind === "edit"
                            ? unlink.mutate(conversation.id)
                            : setLinked((current) => current.filter((item) => item.id !== conversation.id))
                        }
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </form>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error instanceof Error ? error.message : "Something went wrong"}
          </p>
        )}

        <DialogFooter className="max-sm:mt-auto sm:justify-between">
          {target?.kind === "edit" && card ? (
            confirmingDelete ? (
              <div className="flex items-center gap-2 max-sm:order-last">
                <span className="text-sm text-muted-foreground">Delete this item?</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => remove.mutate()}
                  disabled={busy}
                >
                  {remove.isPending ? "Deleting…" : "Delete"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  Keep
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive max-sm:order-last"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy}
              >
                Delete item
              </Button>
            )
          ) : (
            <span className="hidden sm:block" />
          )}
          {!missing && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" form="board-card-form" disabled={busy || !title.trim() || columnId === null}>
                {save.isPending
                  ? "Saving…"
                  : target?.kind === "create"
                    ? "Create item"
                    : "Save"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Links a Conversation to an existing Board Card. */
export function AddToBoardCardDialog(props: {
  open: boolean;
  conversation: BoardCardConversation;
  onOpenChange: (open: boolean) => void;
  onCreateNew: () => void;
}) {
  const invalidate = useInvalidateBoard();
  const board = useQuery({ queryKey: ["board"], queryFn: fetchBoard, enabled: props.open });
  const [search, setSearch] = useState("");
  const link = useMutation({
    mutationFn: (cardId: number) => linkBoardCard(cardId, props.conversation.id),
    onSuccess: async () => {
      await invalidate();
      props.onOpenChange(false);
    },
  });

  const { reset } = link;
  useEffect(() => {
    if (!props.open) return;
    setSearch("");
    reset();
  }, [props.open, reset]);

  const columns = board.data?.columns ?? [];
  const query = search.trim().toLowerCase();
  const groups = columns
    .map((column) => ({
      column,
      cards: (board.data?.cards ?? [])
        .filter((card) => card.column_id === column.id)
        .filter((card) => !query || card.title.toLowerCase().includes(query))
        .sort((a, b) => a.position - b.position),
    }))
    .filter((group) => group.cards.length > 0);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!link.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent fullScreenOnMobile className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to board item</DialogTitle>
          <DialogDescription>
            Link <span className="font-medium text-foreground">{props.conversation.subject || "this conversation"}</span>{" "}
            to an item already on the board.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search items"
            aria-label="Search board items"
            className="pl-8"
          />
        </div>
        <div className="-mx-1 max-h-[min(50dvh,360px)] overflow-y-auto px-1 max-sm:max-h-none max-sm:flex-1">
          {board.isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query ? "No items match." : "The board has no items yet."}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.column.id} className="mb-3">
                <p className="mb-1 px-1 text-xs font-medium text-muted-foreground">{group.column.name}</p>
                <ul className="space-y-1">
                  {group.cards.map((card) => {
                    const already = card.conversations.some((item) => item.id === props.conversation.id);
                    return (
                      <li key={card.id}>
                        <button
                          type="button"
                          disabled={already || link.isPending}
                          onClick={() => link.mutate(card.id)}
                          className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors enabled:hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
                        >
                          <span className="min-w-0 flex-1 truncate text-foreground">{card.title}</span>
                          {already && <span className="shrink-0 text-xs text-muted-foreground">Linked</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        {link.isError && (
          <p className="text-sm text-destructive" role="alert">
            {link.error instanceof Error ? link.error.message : "Couldn’t link the conversation"}
          </p>
        )}
        <DialogFooter className="max-sm:mt-auto">
          <Button type="button" variant="outline" onClick={props.onCreateNew} disabled={link.isPending}>
            Create new item instead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
