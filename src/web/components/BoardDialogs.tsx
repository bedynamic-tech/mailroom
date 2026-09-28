import { cn } from "@/lib/utils";
import { useDeferredValue, useEffect, useId, useState, type FormEvent } from "react";
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
  addBoardCardNote,
  ApiError,
  deleteBoardCardNote,
  fetchBoard,
  fetchBoardCard,
  fetchBoardCardSuggestions,
  linkBoardCard,
  moveBoardCard,
  searchThreads,
  unlinkBoardCard,
  updateBoardCard,
} from "../api";
import {
  BOARD_REMINDER_OPTIONS,
  MAX_BOARD_CARD_DESCRIPTION_LENGTH,
  MAX_BOARD_CARD_TITLE_LENGTH,
  MAX_BOARD_NOTE_LENGTH,
  reminderLabel,
} from "../../shared/board";
import type { BoardCard, BoardCardConversation } from "../../shared/types";
import { ArchiveIcon, BellIcon, BoardIcon, MailIcon, PencilIcon, PlusIcon, SearchIcon, TrashIcon, XIcon } from "./Icons";
import { CalendarClock as CalendarClockIcon } from "lucide-react";

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

type BoardCardDialogProps = {
  target: CardDialogTarget | null;
  onOpenChange: (open: boolean) => void;
  onOpenConversation?: (conversation: BoardCardConversation) => void;
  onCreated?: (card: BoardCard) => void;
};

/** Opens a Board Card's detail view, or the form for a new Card. */
export function BoardCardDialog(props: BoardCardDialogProps) {
  if (props.target?.kind === "edit") {
    return (
      <BoardCardDetailDialog
        cardId={props.target.cardId}
        onClose={() => props.onOpenChange(false)}
        onOpenConversation={props.onOpenConversation}
      />
    );
  }
  return <BoardCardFormDialog {...props} />;
}

/**
 * Creates a Board Card: its title, description, column and the Conversations
 * it links.
 */
function BoardCardFormDialog(props: BoardCardDialogProps) {
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
  const [due, setDue] = useState<DueValue>(EMPTY_DUE);
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
      setDue(dueValueOf(card));
    } else {
      setTitle(target.title ?? "");
      setDescription("");
      setColumnId(target.columnId ?? board.data.columns[0]?.id ?? null);
      setLinked(target.conversation ? [target.conversation] : []);
      setDue(EMPTY_DUE);
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
          ...dueInput(due),
        });
      }
      if (!card) throw new Error("This item no longer exists");
      const updated = await updateBoardCard(card.id, { title, description, ...dueInput(due) });
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

  const link = useMutation({
    mutationFn: (conversation: BoardCardConversation) => linkBoardCard(card!.id, conversation.id),
    onSuccess: (updated) => {
      setLinked(updated.conversations);
      invalidate();
    },
  });
  const addConversation = (conversation: BoardCardConversation) => {
    if (target?.kind === "edit") link.mutate(conversation);
    else setLinked((current) => [...current, conversation]);
  };

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
  const error = save.error ?? remove.error ?? unlink.error ?? link.error;

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
            <DueFields value={due} onChange={setDue} disabled={busy} />
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
              <span className="text-sm font-medium text-foreground">Related conversations</span>
              <LinkedConversations
                conversations={linked}
                disabled={busy || unlink.isPending}
                onOpen={props.onOpenConversation}
                onUnlink={(conversation) =>
                  target?.kind === "edit"
                    ? unlink.mutate(conversation.id)
                    : setLinked((current) => current.filter((item) => item.id !== conversation.id))
                }
              />
              <RelatedConversationPicker
                cardId={card?.id ?? null}
                linkedIds={new Set(linked.map((conversation) => conversation.id))}
                disabled={busy || link.isPending}
                onLink={addConversation}
              />
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

/**
 * Finds Conversations to link to a Board Card: by search, or, for a saved
 * Card, from new mail by the senders it already tracks.
 */
function RelatedConversationPicker(props: {
  cardId: number | null;
  linkedIds: Set<number>;
  disabled: boolean;
  onLink: (conversation: BoardCardConversation) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const results = useQuery({
    queryKey: ["board-link-search", query],
    queryFn: () => searchThreads(query, { mailboxId: null, labelId: null, unread: false }),
    enabled: query.length >= 2,
    staleTime: 30_000,
  });
  const suggestions = useQuery({
    queryKey: ["board", "suggestions", props.cardId],
    queryFn: () => fetchBoardCardSuggestions(props.cardId!),
    enabled: props.cardId !== null,
  });

  const searching = query.length >= 2;
  const rows = (
    searching
      ? (results.data ?? []).map((thread) => ({
          id: thread.id,
          subject: thread.subject,
          status: thread.status,
          mailbox_address: thread.mailbox_address,
          last_from: thread.last_from,
          last_message_at: thread.last_message_at,
        }))
      : (suggestions.data ?? [])
  )
    .filter((row) => !props.linkedIds.has(row.id))
    .slice(0, 6);

  return (
    <div className="space-y-1.5 pt-1">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder="Search conversations to link"
          aria-label="Search conversations to link"
          className="pl-8"
          disabled={props.disabled}
        />
      </div>
      {!searching && rows.length > 0 && (
        <p className="px-0.5 pt-1 text-xs text-muted-foreground">Suggested: newer mail from the same senders</p>
      )}
      {searching && !results.isLoading && rows.length === 0 && (
        <p className="px-0.5 py-1 text-xs text-muted-foreground">No other conversations match.</p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-1" aria-label={searching ? "Search results" : "Suggested conversations"}>
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-2 rounded-lg border border-dashed py-1 pr-1 pl-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{row.subject || "(no subject)"}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[row.last_from, row.status === "archived" ? "Archived" : null].filter(Boolean).join(" · ") ||
                    row.mailbox_address}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={props.disabled}
                onClick={() => props.onLink(row)}
                aria-label={`Link ${row.subject || "conversation"}`}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Link
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LinkedConversations(props: {
  conversations: BoardCardConversation[];
  disabled: boolean;
  onOpen?: (conversation: BoardCardConversation) => void;
  onUnlink?: (conversation: BoardCardConversation) => void;
  emptyText?: string;
}) {
  if (props.conversations.length === 0) {
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        {props.emptyText ?? "None yet. Search below to link one."}
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {props.conversations.map((conversation) => (
        <li key={conversation.id} className="flex items-center gap-1 py-1 pr-1 pl-3">
          <button
            type="button"
            onClick={() => props.onOpen?.(conversation)}
            disabled={!props.onOpen}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm outline-none enabled:hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {conversation.status === "archived" ? (
              <ArchiveIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <MailIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">{conversation.subject || "(no subject)"}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {conversation.mailbox_address}
                {conversation.status === "archived" ? " · Archived" : ""}
              </span>
            </span>
          </button>
          {props.onUnlink && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={`Unlink ${conversation.subject || "conversation"}`}
              title="Unlink"
              disabled={props.disabled}
              onClick={() => props.onUnlink?.(conversation)}
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatDateTime = (value: string) => dateTime.format(new Date(value));

/**
 * A Board Card opened from the board or a Conversation: its name, description
 * and date added, a column picker, timestamped notes and related Conversations.
 */
function BoardCardDetailDialog(props: {
  cardId: number;
  onClose: () => void;
  onOpenConversation?: (conversation: BoardCardConversation) => void;
}) {
  const queryClient = useQueryClient();
  const invalidateBoard = useInvalidateBoard();
  const board = useQuery({ queryKey: ["board"], queryFn: fetchBoard });
  const detail = useQuery({
    queryKey: ["board", "card", props.cardId],
    queryFn: () => fetchBoardCard(props.cardId),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const card = detail.data;
  const columns = board.data?.columns ?? [];
  const invalidate = () =>
    Promise.all([
      invalidateBoard(),
      queryClient.invalidateQueries({ queryKey: ["board", "card", props.cardId] }),
    ]);

  const [editing, setEditing] = useState(false);
  const [columnId, setColumnId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState<DueValue>(EMPTY_DUE);
  const [note, setNote] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const noteId = useId();

  const startEditing = () => {
    if (!card) return;
    setTitle(card.title);
    setDescription(card.description ?? "");
    setColumnId(card.column_id);
    setDue(dueValueOf(card));
    setConfirmingDelete(false);
    setEditing(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      await updateBoardCard(props.cardId, { title, description, ...dueInput(due) });
      if (card && columnId !== null && columnId !== card.column_id) {
        const end = board.data?.cards.filter((item) => item.column_id === columnId).length ?? 0;
        await moveBoardCard(props.cardId, columnId, end);
      }
    },
    onSuccess: async () => {
      await invalidate();
      setEditing(false);
    },
  });
  const addNote = useMutation({
    mutationFn: () => addBoardCardNote(props.cardId, note),
    onSuccess: async () => {
      setNote("");
      await invalidate();
    },
  });
  const removeNote = useMutation({
    mutationFn: (id: number) => deleteBoardCardNote(props.cardId, id),
    onSuccess: invalidate,
  });
  const link = useMutation({
    mutationFn: (conversation: BoardCardConversation) => linkBoardCard(props.cardId, conversation.id),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: (conversation: BoardCardConversation) => unlinkBoardCard(props.cardId, conversation.id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => deleteBoardCard(props.cardId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["board", "card", props.cardId] });
      await invalidateBoard();
      props.onClose();
    },
  });

  const busy = save.isPending || remove.isPending;
  const error = [save, addNote, removeNote, link, unlink, remove].find((m) => m.isError)?.error;
  const submitNote = (event?: FormEvent) => {
    event?.preventDefault();
    if (note.trim() && !addNote.isPending) addNote.mutate();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogContent
        fullScreenOnMobile
        showCloseButton={!busy}
        className="max-h-[min(90dvh,860px)] gap-5 overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {detail.isLoading ? (
          <DialogHeader>
            <DialogTitle>Board item</DialogTitle>
            <DialogDescription>Loading…</DialogDescription>
          </DialogHeader>
        ) : !card ? (
          <DialogHeader>
            <DialogTitle>Board item</DialogTitle>
            <DialogDescription>This item was deleted.</DialogDescription>
          </DialogHeader>
        ) : (
          <>
            {editing ? (
              <form
                id="board-card-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (title.trim() && !busy) save.mutate();
                }}
                className="space-y-4 pr-8"
              >
                <DialogTitle>Edit board item</DialogTitle>
                <DialogDescription className="sr-only">
                  Change the item’s name, description, column and related conversations.
                </DialogDescription>
                <div className="space-y-1.5">
                  <label htmlFor={titleId} className="text-sm font-medium text-foreground">
                    Name
                  </label>
                  <Input
                    id={titleId}
                    autoFocus
                    value={title}
                    maxLength={MAX_BOARD_CARD_TITLE_LENGTH}
                    onChange={(event) => setTitle(event.target.value)}
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
                <DueFields value={due} onChange={setDue} disabled={busy} />
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
                  <span className="text-sm font-medium text-foreground">Related conversations</span>
                  <LinkedConversations
                    conversations={card.conversations}
                    disabled={busy || unlink.isPending}
                    onUnlink={(conversation) => unlink.mutate(conversation)}
                  />
                  <RelatedConversationPicker
                    cardId={card.id}
                    linkedIds={new Set(card.conversations.map((conversation) => conversation.id))}
                    disabled={busy || link.isPending}
                    onLink={(conversation) => link.mutate(conversation)}
                  />
                </div>
              </form>
            ) : (
              <>
                <div className="space-y-2 pr-8">
                  <div className="flex items-start gap-2">
                    <DialogTitle className="min-w-0 flex-1 text-lg leading-7 font-semibold break-words">
                      {card.title}
                    </DialogTitle>
                    <Button variant="outline" size="sm" className="shrink-0" onClick={startEditing}>
                      <PencilIcon className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                  <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span>
                      Added <time dateTime={card.created_at}>{formatDateTime(card.created_at)}</time>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      <BoardIcon className="h-3 w-3" />
                      {columns.find((column) => column.id === card.column_id)?.name ?? ""}
                    </span>
                  </DialogDescription>
                  {card.due_at && <DueSummary card={card} />}
                  {card.description ? (
                    <p className="text-sm leading-6 break-words whitespace-pre-wrap text-foreground">
                      {card.description}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No description.</p>
                  )}
                </div>

                <section aria-labelledby={noteId} className="space-y-2 border-t pt-4">
                  <h3 id={noteId} className="text-sm font-medium text-foreground">
                    Notes
                  </h3>
                  <form onSubmit={submitNote} className="space-y-2">
                    <Textarea
                      value={note}
                      maxLength={MAX_BOARD_NOTE_LENGTH}
                      onChange={(event) => setNote(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitNote();
                      }}
                      placeholder="Add a note"
                      aria-label="New note"
                      disabled={addNote.isPending}
                      className="min-h-16"
                    />
                    <Button type="submit" size="sm" disabled={!note.trim() || addNote.isPending}>
                      {addNote.isPending ? "Adding…" : "Add note"}
                    </Button>
                  </form>
                  {card.notes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No notes yet.</p>
                  ) : (
                    <ol className="space-y-2">
                      {[...card.notes].reverse().map((entry) => (
                        <li key={entry.id} className="rounded-lg bg-muted/50 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <time dateTime={entry.created_at} className="flex-1 text-xs text-muted-foreground">
                              {formatDateTime(entry.created_at)}
                            </time>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="text-muted-foreground"
                              aria-label={`Delete note from ${formatDateTime(entry.created_at)}`}
                              title="Delete note"
                              disabled={removeNote.isPending}
                              onClick={() => removeNote.mutate(entry.id)}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          <p className="mt-0.5 text-sm leading-6 break-words whitespace-pre-wrap text-foreground">
                            {entry.body}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                {card.conversations.length > 0 && (
                  <section className="space-y-1.5 border-t pt-4">
                    <h3 className="text-sm font-medium text-foreground">Related conversations</h3>
                    <LinkedConversations
                      conversations={card.conversations}
                      disabled={false}
                      onOpen={props.onOpenConversation}
                    />
                  </section>
                )}
              </>
            )}
          </>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error instanceof Error ? error.message : "Something went wrong"}
          </p>
        )}

        {card && (
          <DialogFooter className={cn("border-t pt-4 max-sm:mt-auto", editing && "sm:justify-between")}>
            {editing ? (
              <>
                {confirmingDelete ? (
                  <div className="flex flex-wrap items-center gap-2 max-sm:order-last">
                    <span className="text-sm text-muted-foreground max-sm:w-full">
                      Delete this item and its notes?
                    </span>
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
                    className="text-destructive hover:text-destructive max-sm:order-last -ml-2.5 max-sm:self-start"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={busy}
                  >
                    <TrashIcon className="h-4 w-4" />
                    Delete item
                  </Button>
                )}
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <Button variant="outline" onClick={() => setEditing(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button type="submit" form="board-card-edit" disabled={busy || !title.trim()}>
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="outline" onClick={props.onClose}>
                Close
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The due time as picked in the form: a local datetime-local value and a reminder. */
type DueValue = { local: string; reminder: string };
const EMPTY_DUE: DueValue = { local: "", reminder: "none" };

function dueValueOf(card: BoardCard): DueValue {
  return {
    local: card.due_at ? toLocalInput(card.due_at) : "",
    reminder: card.reminder_minutes === null ? "none" : String(card.reminder_minutes),
  };
}

/** A local "YYYY-MM-DDTHH:mm" value for a datetime-local input. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dueInput(value: DueValue) {
  const date = value.local ? new Date(value.local) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return { due_at: null, due_time_zone: null, reminder_minutes: null };
  }
  return {
    due_at: date.toISOString(),
    due_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    reminder_minutes: value.reminder === "none" ? null : Number(value.reminder),
  };
}

/** Due date, time and reminder fields shared by the new-item and edit forms. */
function DueFields(props: { value: DueValue; onChange: (value: DueValue) => void; disabled: boolean }) {
  const dueId = useId();
  const { local, reminder } = props.value;
  return (
    <div className="space-y-1.5">
      <label htmlFor={dueId} className="text-sm font-medium text-foreground">
        Due
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={dueId}
          type="datetime-local"
          value={local}
          onChange={(event) => props.onChange({ ...props.value, local: event.target.value })}
          disabled={props.disabled}
          className="w-auto min-w-[13rem] flex-1"
        />
        <Select
          value={reminder}
          onValueChange={(next) => props.onChange({ ...props.value, reminder: next })}
          disabled={props.disabled || !local}
        >
          <SelectTrigger aria-label="Reminder" className="min-w-[11rem] flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="none">No reminder</SelectItem>
            {BOARD_REMINDER_OPTIONS.map((option) => (
              <SelectItem key={option.minutes} value={String(option.minutes)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {local && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => props.onChange(EMPTY_DUE)}
            disabled={props.disabled}
          >
            Clear
          </Button>
        )}
      </div>
      {local && reminder !== "none" && (
        <p className="text-xs text-muted-foreground">
          Reminders go out by browser, email or both, as set in Settings.
        </p>
      )}
    </div>
  );
}

function DueSummary(props: { card: BoardCard }) {
  const { due_at, reminder_minutes, reminder_sent_at } = props.card;
  if (!due_at) return null;
  const overdue = Date.parse(due_at) <= Date.now();
  const reminder = reminderLabel(reminder_minutes);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={cn("inline-flex items-center gap-1.5", overdue ? "text-destructive" : "text-foreground")}>
        <CalendarClockIcon className="h-4 w-4" aria-hidden />
        {overdue ? "Was due" : "Due"} <time dateTime={due_at}>{formatDateTime(due_at)}</time>
      </span>
      {reminder && !overdue && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <BellIcon className="h-3 w-3" />
          {reminder_sent_at ? "Reminder sent" : `Reminder ${reminder.toLowerCase()}`}
        </span>
      )}
    </p>
  );
}
