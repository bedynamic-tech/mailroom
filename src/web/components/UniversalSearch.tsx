import {
  createContext,
  Fragment,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ListFilter } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UniversalSearchResults } from "../../shared/types";
import { searchEverything } from "../api";
import { formatTime } from "../lib";
import { BoardIcon, ContactsIcon, MailIcon, NoteIcon, SearchIcon, XIcon } from "./Icons";

const SearchContext = createContext<() => void>(() => {});
/** Opens the universal search. */
export const useUniversalSearch = () => useContext(SearchContext);

type ResultKind = "conversation" | "note" | "board" | "rule" | "contact";

interface ResultRow {
  key: string;
  kind: ResultKind;
  title: string;
  meta: string;
  excerpt: string;
  path: string;
}

const GROUPS: Array<{ kind: ResultKind; label: string }> = [
  { kind: "conversation", label: "Conversations" },
  { kind: "note", label: "Internal notes" },
  { kind: "board", label: "Board items" },
  { kind: "rule", label: "Rules" },
  { kind: "contact", label: "Contacts" },
];

function threadPath(id: number, status: string) {
  return `${status === "archived" ? "/archive" : "/inbox"}/${id}`;
}

/** Flattens grouped results into rows, in the order the groups are shown. */
function toRows(results: UniversalSearchResults): ResultRow[] {
  return [
    ...results.conversations.map((row) => ({
      key: `conversation-${row.id}`,
      kind: "conversation" as const,
      title: row.subject || "(no subject)",
      meta: [row.from, row.status === "archived" ? "Archived" : null, formatTime(row.last_message_at)]
        .filter(Boolean)
        .join(" · "),
      excerpt: row.excerpt,
      path: threadPath(row.id, row.status),
    })),
    ...results.notes.map((row) => ({
      key: `note-${row.id}`,
      kind: "note" as const,
      title: row.excerpt,
      meta: [
        `On ${row.thread_subject || "(no subject)"}`,
        row.mail_rule_name ? `Rule: ${row.mail_rule_name}` : null,
        formatTime(row.created_at),
      ]
        .filter(Boolean)
        .join(" · "),
      excerpt: "",
      path: threadPath(row.thread_id, row.thread_status),
    })),
    ...results.board_items.map((row) => ({
      key: `board-${row.id}`,
      kind: "board" as const,
      title: row.title,
      meta: row.matched_note ? `${row.column_name} · In a note` : row.column_name,
      excerpt: row.excerpt,
      path: `/board/cards/${row.id}`,
    })),
    ...results.rules.map((row) => ({
      key: `rule-${row.id}`,
      kind: "rule" as const,
      title: row.name,
      meta: [row.mailbox_address ?? "All inboxes", row.enabled ? null : "Off"].filter(Boolean).join(" · "),
      excerpt: row.excerpt,
      path: `/settings/rules/${row.id}`,
    })),
    ...results.contacts.map((row) => ({
      key: `contact-${row.id}`,
      kind: "contact" as const,
      title: row.name || row.address,
      meta: [row.name ? row.address : null, row.company].filter(Boolean).join(" · "),
      excerpt: "",
      path: `/contacts/${row.id}`,
    })),
  ];
}

export function UniversalSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SearchContext.Provider value={() => setOpen(true)}>
      {children}
      <UniversalSearchDialog open={open} onOpenChange={setOpen} />
    </SearchContext.Provider>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The search field in the top bar; it opens the search dialog. */
export function UniversalSearchTrigger(props: { className?: string }) {
  const openSearch = useUniversalSearch();
  return (
    <button
      type="button"
      onClick={openSearch}
      aria-label="Search everything"
      className={cn(
        "flex h-8 w-72 items-center gap-2 rounded-md border bg-muted/50 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        props.className,
      )}
    >
      <SearchIcon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate text-left">Search everything</span>
      <kbd className="inline-flex h-5 items-center rounded border bg-background px-1 font-sans text-xs font-medium">
        {isMac ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

/** A search icon button for phone headers. */
export function UniversalSearchButton(props: { className?: string }) {
  const openSearch = useUniversalSearch();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={openSearch}
      aria-label="Search everything"
      title="Search everything"
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", props.className)}
    >
      <SearchIcon className="h-5 w-5" />
    </Button>
  );
}

function UniversalSearchDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const deferred = useDeferredValue(query.trim());
  const results = useQuery({
    queryKey: ["universal-search", deferred],
    queryFn: () => searchEverything(deferred),
    enabled: props.open && deferred.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: false,
    staleTime: 5_000,
  });
  const rows = useMemo(
    () => (deferred && results.data ? toRows(results.data) : []),
    [deferred, results.data],
  );
  const terms = useMemo(() => deferred.toLowerCase().split(/\s+/).filter(Boolean), [deferred]);

  useEffect(() => setActive(0), [rows]);
  useEffect(() => {
    if (!props.open) setQuery("");
  }, [props.open]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: ResultRow) => {
    props.onOpenChange(false);
    navigate(row.path);
  };

  const searching = deferred.length > 0 && (results.isFetching || deferred !== query.trim());

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        fullScreenOnMobile
        showCloseButton={false}
        className="flex max-h-[min(640px,80dvh)] flex-col gap-0 overflow-hidden p-0 sm:top-[12vh] sm:max-w-xl sm:translate-y-0"
      >
        <DialogTitle className="sr-only">Search everything</DialogTitle>
        <DialogDescription className="sr-only">
          Search conversations, internal notes, board items, rules and contacts.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3 max-sm:pt-1">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && rows.length) {
                event.preventDefault();
                setActive((index) => (index + 1) % rows.length);
              } else if (event.key === "ArrowUp" && rows.length) {
                event.preventDefault();
                setActive((index) => (index - 1 + rows.length) % rows.length);
              } else if (event.key === "Enter" && rows[active]) {
                event.preventDefault();
                choose(rows[active]);
              }
            }}
            placeholder="Search emails, notes, board items, rules and contacts"
            aria-label="Search everything"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="universal-search-results"
            aria-activedescendant={rows[active] ? `universal-search-${rows[active].key}` : undefined}
            className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
          />
          <span
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-muted-foreground/20 border-t-muted-foreground transition-opacity",
              searching ? "animate-spin opacity-100" : "opacity-0",
            )}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => props.onOpenChange(false)}
            aria-label="Close search"
            className="-mr-1 text-muted-foreground"
          >
            <XIcon className="h-4 w-4" />
          </Button>
        </div>

        <div
          ref={listRef}
          id="universal-search-results"
          role="listbox"
          aria-label="Search results"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {!deferred ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Find conversations, internal notes, board items, rules and contacts.
            </p>
          ) : results.isError ? (
            <p className="px-3 py-8 text-center text-sm text-destructive">
              Search failed. Try again.
            </p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {results.isLoading ? "Searching…" : `Nothing matches “${deferred}”.`}
            </p>
          ) : (
            GROUPS.map((group) => {
              const groupRows = rows.filter((row) => row.kind === group.kind);
              if (groupRows.length === 0) return null;
              return (
                <div key={group.kind} role="group" aria-label={group.label} className="pb-1">
                  <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                  {groupRows.map((row) => {
                    const index = rows.indexOf(row);
                    return (
                      <div
                        key={row.key}
                        id={`universal-search-${row.key}`}
                        data-index={index}
                        role="option"
                        aria-selected={index === active}
                        onMouseMove={() => setActive(index)}
                        onClick={() => choose(row)}
                        className={cn(
                          "flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2",
                          index === active && "bg-muted",
                        )}
                      >
                        <ResultIcon kind={row.kind} />
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn(
                              "text-sm font-medium text-foreground",
                              row.kind === "note" ? "line-clamp-2" : "truncate",
                            )}
                          >
                            <Highlight text={row.title} terms={terms} />
                          </div>
                          {row.meta && (
                            <div className="truncate text-xs text-muted-foreground">{row.meta}</div>
                          )}
                          {row.excerpt && (
                            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                              <Highlight text={row.excerpt} terms={terms} />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-3 border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:flex">
          <span>
            <Key>↑</Key> <Key>↓</Key> to move
          </span>
          <span>
            <Key>Enter</Key> to open
          </span>
          <span>
            <Key>Esc</Key> to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Key(props: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-background px-1 font-sans text-xs font-medium">
      {props.children}
    </kbd>
  );
}

function ResultIcon(props: { kind: ResultKind }) {
  const className = "h-4 w-4";
  return (
    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
      {props.kind === "conversation" ? (
        <MailIcon className={className} />
      ) : props.kind === "note" ? (
        <NoteIcon className={`${className} text-amber-600 dark:text-amber-400`} />
      ) : props.kind === "board" ? (
        <BoardIcon className={className} />
      ) : props.kind === "rule" ? (
        <ListFilter className={className} />
      ) : (
        <ContactsIcon className={className} />
      )}
    </span>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Marks every search term in the text. */
function Highlight(props: { text: string; terms: string[] }) {
  if (props.terms.length === 0) return <>{props.text}</>;
  const pattern = new RegExp(`(${props.terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = props.text.split(pattern);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-yellow-200/70 text-inherit dark:bg-yellow-400/25">
            {part}
          </mark>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
