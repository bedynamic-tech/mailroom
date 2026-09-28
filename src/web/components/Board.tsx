import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  createBoardColumn,
  deleteBoardColumn,
  fetchBoard,
  moveBoardCard,
  renameBoardColumn,
  reorderBoardColumns,
} from "../api";
import { MAX_BOARD_COLUMN_NAME_LENGTH, MAX_BOARD_COLUMNS } from "../../shared/board";
import type { Board as BoardData, BoardCard, BoardCardConversation, BoardColumn } from "../../shared/types";
import { BoardCardDialog, type CardDialogTarget } from "./BoardDialogs";
import { ArrowLeftIcon, BoardIcon, MailIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from "./Icons";

type Layout = Map<number, number[]>;

const cardKey = (id: number) => `card-${id}`;
const columnKey = (id: number) => `column-${id}`;
const parseKey = (key: string | number) => {
  const [kind, id] = String(key).split("-");
  return { kind: kind as "card" | "column", id: Number(id) };
};

function layoutOf(board: BoardData): Layout {
  const layout: Layout = new Map(board.columns.map((column) => [column.id, []]));
  const cards = [...board.cards].sort((a, b) => a.position - b.position || a.id - b.id);
  for (const card of cards) layout.get(card.column_id)?.push(card.id);
  return layout;
}

function columnOf(layout: Layout, cardId: number): number | null {
  for (const [columnId, ids] of layout) if (ids.includes(cardId)) return columnId;
  return null;
}

export function Board(props: {
  cardId: number | null;
  onOpenCard: (id: number) => void;
  onCloseCard: () => void;
  onBack: () => void;
  onOpenConversation: (conversation: BoardCardConversation) => void;
}) {
  const queryClient = useQueryClient();
  const board = useQuery({ queryKey: ["board"], queryFn: fetchBoard, refetchInterval: 30_000 });
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);
  const [activeCard, setActiveCard] = useState<number | null>(null);
  const [creating, setCreating] = useState<CardDialogTarget | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [deletingColumn, setDeletingColumn] = useState<BoardColumn | null>(null);

  const cards = useMemo(
    () => new Map((board.data?.cards ?? []).map((card) => [card.id, card])),
    [board.data],
  );
  const layout = useMemo(
    () => dragLayout ?? (board.data ? layoutOf(board.data) : new Map()),
    [board.data, dragLayout],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const move = useMutation({
    mutationFn: (args: { cardId: number; columnId: number; index: number }) =>
      moveBoardCard(args.cardId, args.columnId, args.index),
    onSuccess: (next) => queryClient.setQueryData(["board"], next),
    onError: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });

  const reorder = useMutation({
    mutationFn: reorderBoardColumns,
    onSuccess: (next) => queryClient.setQueryData(["board"], next),
    onError: () => queryClient.invalidateQueries({ queryKey: ["board"] }),
  });

  const onDragStart = (event: DragStartEvent) => {
    if (!board.data) return;
    setActiveCard(parseKey(event.active.id).id);
    setDragLayout(layoutOf(board.data));
  };

  // Moving into another column happens while dragging, so the column opens a gap.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || !dragLayout) return;
    const activeId = parseKey(active.id).id;
    const target = parseKey(over.id);
    const from = columnOf(dragLayout, activeId);
    const to = target.kind === "column" ? target.id : columnOf(dragLayout, target.id);
    if (from === null || to === null || from === to) return;
    setDragLayout((current) => {
      if (!current) return current;
      const next = new Map(current);
      const source = next.get(from)!.filter((id) => id !== activeId);
      const destination = [...next.get(to)!];
      const overIndex = target.kind === "card" ? destination.indexOf(target.id) : -1;
      destination.splice(overIndex < 0 ? destination.length : overIndex, 0, activeId);
      next.set(from, source);
      next.set(to, destination);
      return next;
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const current = dragLayout;
    setActiveCard(null);
    if (!current || !board.data) {
      setDragLayout(null);
      return;
    }
    const activeId = parseKey(active.id).id;
    const columnId = columnOf(current, activeId);
    if (columnId === null) {
      setDragLayout(null);
      return;
    }
    let ids = current.get(columnId)!;
    if (over) {
      const target = parseKey(over.id);
      if (target.kind === "card" && target.id !== activeId && ids.includes(target.id)) {
        ids = arrayMove(ids, ids.indexOf(activeId), ids.indexOf(target.id));
      }
    }
    const index = ids.indexOf(activeId);
    const original = cards.get(activeId);
    const originalIndex = layoutOf(board.data).get(original?.column_id ?? -1)?.indexOf(activeId);
    setDragLayout(null);
    if (original?.column_id === columnId && originalIndex === index) return;

    // Show the drop immediately; the server's board replaces it.
    const final = new Map(current).set(columnId, ids);
    queryClient.setQueryData<BoardData>(["board"], (data) =>
      data && {
        ...data,
        cards: data.cards.map((card) => {
          for (const [column, order] of final) {
            const position = order.indexOf(card.id);
            if (position >= 0) return { ...card, column_id: column, position };
          }
          return card;
        }),
      },
    );
    move.mutate({ cardId: activeId, columnId, index });
  };

  const moveColumn = (columnId: number, offset: -1 | 1) => {
    const ids = (board.data?.columns ?? []).map((column) => column.id);
    const from = ids.indexOf(columnId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = arrayMove(ids, from, to);
    queryClient.setQueryData<BoardData>(["board"], (data) =>
      data && {
        ...data,
        columns: data.columns
          .map((column) => ({ ...column, position: next.indexOf(column.id) }))
          .sort((a, b) => a.position - b.position),
      },
    );
    reorder.mutate(next);
  };

  const columns = board.data?.columns ?? [];
  const dragged = activeCard === null ? undefined : cards.get(activeCard);
  const dialogTarget: CardDialogTarget | null =
    creating ?? (props.cardId !== null ? { kind: "edit", cardId: props.cardId } : null);

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1.5 lg:hidden"
          aria-label="Back to inbox"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold tracking-[-0.015em] text-foreground">
          Board
        </h1>
      </header>

      {board.isLoading ? (
        <BoardSkeleton />
      ) : board.isError || !board.data ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <BoardIcon className="h-[18px] w-[18px]" />
          </span>
          <p className="mt-3 text-sm font-medium text-foreground">Couldn’t load the board</p>
          <Button variant="outline" onClick={() => board.refetch()} className="mt-4">
            Try again
          </Button>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setActiveCard(null);
            setDragLayout(null);
          }}
        >
          <div className="min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain sm:snap-none">
            <div className="flex h-full w-max items-stretch gap-3 px-4 py-4 md:px-6">
              {columns.map((column, index) => (
                <BoardColumnView
                  key={column.id}
                  column={column}
                  cardIds={layout.get(column.id) ?? []}
                  cards={cards}
                  first={index === 0}
                  last={index === columns.length - 1}
                  onOpenCard={props.onOpenCard}
                  onAddCard={() => setCreating({ kind: "create", columnId: column.id })}
                  onMove={(offset) => moveColumn(column.id, offset)}
                  onDelete={() => setDeletingColumn(column)}
                />
              ))}
              {addingColumn ? (
                <NewColumnForm onDone={() => setAddingColumn(false)} />
              ) : (
                columns.length < MAX_BOARD_COLUMNS && (
                  <button
                    type="button"
                    onClick={() => setAddingColumn(true)}
                    className="flex h-10 w-[min(82vw,18rem)] shrink-0 snap-start items-center gap-2 rounded-xl border border-dashed px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-72"
                  >
                    <PlusIcon className="h-4 w-4" />
                    Add column
                  </button>
                )
              )}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {dragged ? <CardFace card={dragged} className="rotate-1 shadow-lg ring-foreground/20" /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <BoardCardDialog
        target={dialogTarget}
        onOpenChange={(open) => {
          if (open) return;
          if (creating) setCreating(null);
          else props.onCloseCard();
        }}
        onOpenConversation={props.onOpenConversation}
      />
      <DeleteColumnDialog
        column={deletingColumn}
        cardCount={deletingColumn ? (layout.get(deletingColumn.id)?.length ?? 0) : 0}
        onlyColumn={columns.length <= 1}
        onOpenChange={(open) => !open && setDeletingColumn(null)}
      />
    </div>
  );
}

function BoardColumnView(props: {
  column: BoardColumn;
  cardIds: number[];
  cards: Map<number, BoardCard>;
  first: boolean;
  last: boolean;
  onOpenCard: (id: number) => void;
  onAddCard: () => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnKey(props.column.id) });
  const [renaming, setRenaming] = useState(false);

  return (
    <section
      aria-label={props.column.name}
      className="flex max-h-full w-[min(82vw,18rem)] shrink-0 snap-start flex-col rounded-xl bg-muted/50 ring-1 ring-foreground/5 sm:w-72 dark:bg-muted/30"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 pr-1.5 pl-3">
        {renaming ? (
          <RenameColumnForm column={props.column} onDone={() => setRenaming(false)} />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground" title={props.column.name}>
              {props.column.name}
            </h2>
            <span className="ml-1 text-xs tabular-nums text-muted-foreground">{props.cardIds.length}</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={`Add item to ${props.column.name}`}
              title="Add item"
              onClick={props.onAddCard}
            >
              <PlusIcon className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={`${props.column.name} column options`}
                >
                  <MoreIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenaming(true)}>
                  <PencilIcon />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={props.first} onSelect={() => props.onMove(-1)}>
                  <ArrowLeftIcon />
                  Move left
                </DropdownMenuItem>
                <DropdownMenuItem disabled={props.last} onSelect={() => props.onMove(1)}>
                  <ArrowLeftIcon className="rotate-180" />
                  Move right
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={props.onDelete}>
                  <TrashIcon />
                  Delete column
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      <SortableContext items={props.cardIds.map(cardKey)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            "min-h-16 flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-b-xl px-2 pb-2 transition-colors",
            isOver && props.cardIds.length === 0 && "bg-muted",
          )}
        >
          {props.cardIds.map((id) => {
            const card = props.cards.get(id);
            return card ? <SortableCard key={id} card={card} onOpen={() => props.onOpenCard(id)} /> : null;
          })}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableCard(props: { card: BoardCard; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cardKey(props.card.id),
  });
  return (
    <CardFace
      ref={setNodeRef}
      card={props.card}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable board item"
      onClick={props.onOpen}
      onKeyDown={(event) => {
        listeners?.onKeyDown?.(event);
        if (event.key === "Enter" && !event.defaultPrevented) props.onOpen();
      }}
    />
  );
}

function CardFace({
  card,
  className,
  ref,
  ...rest
}: { card: BoardCard; ref?: React.Ref<HTMLDivElement> } & React.HTMLAttributes<HTMLDivElement>) {
  const [first] = card.conversations;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      {...rest}
      className={cn(
        "block w-full cursor-grab touch-manipulation rounded-lg bg-background p-3 text-left shadow-xs ring-1 ring-foreground/10 outline-none select-none [-webkit-touch-callout:none] hover:ring-foreground/20 focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing",
        className,
      )}
    >
      <p className="text-sm leading-5 font-medium break-words text-foreground">{card.title}</p>
      {card.description && (
        <p className="mt-1 line-clamp-2 text-xs leading-5 break-words whitespace-pre-line text-muted-foreground">
          {card.description}
        </p>
      )}
      {(first || card.note_count > 0) && (
        <p className="mt-2 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          {first && (
            <span className="flex min-w-0 items-center gap-1.5">
              <MailIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {card.conversations.length === 1
                  ? first.subject || "(no subject)"
                  : `${card.conversations.length} conversations`}
              </span>
            </span>
          )}
          {card.note_count > 0 && (
            <span className="flex shrink-0 items-center gap-1.5">
              <PencilIcon className="h-3.5 w-3.5" />
              {card.note_count === 1 ? "1 note" : `${card.note_count} notes`}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function NewColumnForm(props: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  // The form opens after the last column, which can be off screen on a phone.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    formRef.current?.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
    // A menu that opened the form returns focus to its trigger as it closes; take it back.
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const create = useMutation({
    mutationFn: () => createBoardColumn(name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["board"] });
      props.onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className="w-[min(82vw,18rem)] shrink-0 snap-start self-start rounded-xl bg-muted/50 p-2 ring-1 ring-foreground/5 sm:w-72 dark:bg-muted/30"
    >
      <Input
        ref={inputRef}
        value={name}
        maxLength={MAX_BOARD_COLUMN_NAME_LENGTH}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && props.onDone()}
        placeholder="Column name"
        aria-label="Column name"
        disabled={create.isPending}
      />
      {create.isError && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
          {create.error instanceof Error ? create.error.message : "Couldn’t add the column"}
        </p>
      )}
      <div className="mt-2 flex gap-1.5">
        <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Adding…" : "Add column"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onDone} disabled={create.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RenameColumnForm(props: { column: BoardColumn; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(props.column.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const rename = useMutation({
    mutationFn: () => renameBoardColumn(props.column.id, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["board"] });
      props.onDone();
    },
  });
  useEffect(() => {
    // The menu returns focus to its trigger as it closes; take it back.
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (rename.isPending) return;
    if (!name.trim() || name.trim() === props.column.name) props.onDone();
    else rename.mutate();
  };
  return (
    <form onSubmit={submit} className="-ml-1.5 flex-1">
      <Input
        ref={inputRef}
        value={name}
        maxLength={MAX_BOARD_COLUMN_NAME_LENGTH}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => submit()}
        onKeyDown={(event) => event.key === "Escape" && props.onDone()}
        aria-label="Column name"
        aria-invalid={rename.isError || undefined}
        title={rename.error instanceof Error ? rename.error.message : undefined}
        disabled={rename.isPending}
        className="h-8"
      />
    </form>
  );
}

function DeleteColumnDialog(props: {
  column: BoardColumn | null;
  cardCount: number;
  onlyColumn: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => deleteBoardColumn(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["board"] }),
        queryClient.invalidateQueries({ queryKey: ["thread"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
      ]);
      props.onOpenChange(false);
    },
  });
  const { reset } = remove;
  useEffect(() => reset(), [props.column, reset]);

  return (
    <Dialog
      open={props.column !== null}
      onOpenChange={(open) => {
        if (!remove.isPending) props.onOpenChange(open);
      }}
    >
      <DialogContent showCloseButton={!remove.isPending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{props.column?.name}”?</DialogTitle>
          <DialogDescription>
            {props.onlyColumn
              ? "A board needs at least one column. Add another column first."
              : props.cardCount === 0
                ? "The column is empty."
                : `Its ${props.cardCount === 1 ? "item" : `${props.cardCount} items`} will be deleted too. Linked conversations are kept.`}
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <p className="text-sm text-destructive" role="alert">
            {remove.error instanceof Error ? remove.error.message : "Couldn’t delete the column"}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => props.column && remove.mutate(props.column.id)}
            disabled={remove.isPending || props.onlyColumn}
          >
            {remove.isPending ? "Deleting…" : "Delete column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden px-4 py-4 md:px-6" aria-busy="true" aria-label="Loading board">
      {[3, 2, 1].map((count, index) => (
        <div key={index} className="w-[min(82vw,18rem)] shrink-0 space-y-2 rounded-xl bg-muted/50 p-2 sm:w-72">
          <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          {Array.from({ length: count }, (_, item) => (
            <div key={item} className="h-16 animate-pulse rounded-lg bg-background ring-1 ring-foreground/5" />
          ))}
        </div>
      ))}
    </div>
  );
}
