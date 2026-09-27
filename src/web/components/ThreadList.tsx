import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import type { Label, Mailbox, ThreadSummary } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bulkUpdateThreads, type BulkThreadAction } from "../api";
import { formatTime } from "../lib";
import { EmailAvatar } from "./EmailAvatar";
import {
  ArchiveIcon,
  InboxIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  TagIcon,
  XIcon,
} from "./Icons";

export type ThreadFilter = "all" | "unread";
export type ThreadScope = "all" | "archive" | number;

export function ThreadList(props: {
  mailboxes: Mailbox[];
  threads: ThreadSummary[];
  labels: Label[];
  title: string;
  selected: number | null;
  selectedMailbox: number | null;
  scope: ThreadScope;
  archive: boolean;
  unreadCount: number | null;
  showMailboxChip: boolean;
  search: string;
  filter: ThreadFilter;
  activeLabel: number | null;
  loading: boolean;
  fetching: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  error: boolean;
  detailsOpen: boolean;
  emptyInbox: boolean;
  onSearch: (q: string) => void;
  onFilter: (filter: ThreadFilter) => void;
  onSelectLabel: (id: number | null) => void;
  onSelectScope: (scope: ThreadScope) => void;
  onOpenSettings: () => void;
  onCompose: () => void;
  onOpenMailboxSettings: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const visibleThreads = props.threads;

  const visibleIds = useMemo(
    () => new Set(visibleThreads.map((thread) => thread.id)),
    [visibleThreads],
  );

  useEffect(() => {
    setChecked((current) => {
      const kept = [...current].filter((id) => visibleIds.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [visibleIds]);

  const availableLabels = useMemo(
    () =>
      props.labels.filter(
        (label) =>
          props.selectedMailbox === null || label.mailbox_id === props.selectedMailbox,
      ),
    [props.labels, props.selectedMailbox],
  );

  const mailboxAddress = useMemo(
    () => new Map(props.mailboxes.map((mailbox) => [mailbox.id, mailbox.address])),
    [props.mailboxes],
  );

  const bulkUpdate = useMutation({
    mutationFn: ({ ids, action }: { ids: number[]; action: BulkThreadAction }) =>
      bulkUpdateThreads(ids, action),
    onSuccess: () => {
      setChecked(new Set());
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    },
  });

  const toggleChecked = (id: number, value: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const checkedCount = checked.size;
  const allChecked = visibleThreads.length > 0 && checkedCount === visibleThreads.length;

  const checkedAllArchived =
    checkedCount > 0 &&
    visibleThreads.every((thread) => !checked.has(thread.id) || thread.status === "archived");

  const selectionMode = checkedCount > 0;
  const showFetching = props.fetching && !props.loading;

  return (
    <section
      className={`w-full shrink-0 flex-col border-r bg-background md:w-[368px] xl:w-[400px] ${
        props.detailsOpen ? "hidden md:flex" : "flex"
      }`}
    >
      <header className="border-b px-4 pt-3.5 pb-2.5">
        <div className="mb-3 flex h-8 items-center justify-between gap-3">
          <div className="hidden min-w-0 flex-1 items-baseline gap-2 lg:flex">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
              {props.title}
            </h1>
            <span className="relative h-3.5 w-3.5 shrink-0 self-center" role="status" aria-live="polite">
              <span
                aria-hidden="true"
                className={`absolute inset-0 rounded-full border-[1.5px] border-muted-foreground/20 border-t-muted-foreground transition-opacity duration-300 ${
                  showFetching ? "animate-spin opacity-100" : "opacity-0"
                }`}
              />
              <span className="sr-only">{showFetching ? "Refreshing conversations" : ""}</span>
            </span>
          </div>
          {props.selectedMailbox !== null && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => props.onOpenMailboxSettings(props.selectedMailbox!)}
              aria-label="Inbox settings"
              title="Inbox settings"
              className="-mr-1.5 hidden text-muted-foreground lg:inline-flex"
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
          )}

          <div className="flex min-w-0 flex-1 items-center justify-between gap-2 lg:hidden">
            <Select
              value={String(props.scope)}
              onValueChange={(value) =>
                props.onSelectScope(value === "all" || value === "archive" ? value : Number(value))
              }
            >
              <SelectTrigger
                className="-ml-2 h-8 min-w-0 max-w-[calc(100%-2.75rem)] border-transparent px-2 text-[15px] font-semibold shadow-none hover:bg-muted"
                aria-label="Choose inbox"
              >
                <SelectValue placeholder="All inboxes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All inboxes</SelectItem>
                {props.mailboxes.map((mailbox) => (
                  <SelectItem key={mailbox.id} value={String(mailbox.id)}>
                    {mailbox.address}
                  </SelectItem>
                ))}
                <SelectItem value="archive">Archive</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={props.onCompose} aria-label="Compose new message" title="Compose new message" className="shrink-0"><SquarePen className="h-4 w-4" /></Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onOpenSettings}
              aria-label="Open settings"
              title="Settings"
              className="-mr-1.5 text-muted-foreground"
            >
              <SettingsIcon className="h-[18px] w-[18px]" />
            </Button>
          </div>
        </div>

        {!props.emptyInbox && (
          <>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={props.search}
                onChange={(event) => props.onSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    props.onSearch("");
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search conversations"
                aria-label="Search conversations"
                className="h-9 w-full bg-muted/50 pr-9 pl-8.5 text-[13px] focus-visible:bg-background"
              />
              {props.search ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => props.onSearch("")}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
                  aria-label="Clear search"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <kbd className="pointer-events-none absolute top-1/2 right-2 hidden h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded border bg-background px-1 font-sans text-[11px] text-muted-foreground sm:flex">
                  /
                </kbd>
              )}
            </div>

            <div className="mt-2.5 flex h-8 items-center gap-2 sm:gap-3">
              {visibleThreads.length > 0 && (
                <span className="flex w-8 shrink-0 justify-center">
                  <Checkbox
                    checked={allChecked ? true : selectionMode ? "indeterminate" : false}
                    onCheckedChange={(value) =>
                      setChecked(value === true ? new Set(visibleThreads.map((t) => t.id)) : new Set())
                    }
                    aria-label={allChecked ? "Deselect all conversations" : "Select all conversations"}
                  />
                </span>
              )}
              {selectionMode ? (
                <>
                  <span className="text-[13px] font-medium tabular-nums text-foreground">
                    {checkedCount} selected
                  </span>
                  <span className="ml-auto flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={bulkUpdate.isPending}
                      onClick={() => bulkUpdate.mutate({ ids: [...checked], action: "read" })}
                    >
                      Mark read
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={bulkUpdate.isPending}
                      onClick={() =>
                        bulkUpdate.mutate({
                          ids: [...checked],
                          action: checkedAllArchived ? "unarchive" : "archive",
                        })
                      }
                    >
                      {checkedAllArchived ? (
                        <>
                          <InboxIcon className="h-3.5 w-3.5" />
                          Move to inbox
                        </>
                      ) : (
                        <>
                          <ArchiveIcon className="h-3.5 w-3.5" />
                          Archive
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setChecked(new Set())}
                      aria-label="Clear selection"
                      className="text-muted-foreground"
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </>
              ) : (
                <>
                  <Tabs
                    value={props.filter}
                    onValueChange={(value) => props.onFilter(value as ThreadFilter)}
                    className="gap-0"
                  >
                    <TabsList aria-label="Conversation filter" className="h-7!">
                      <FilterTab value="all" label="All" />
                      <FilterTab value="unread" label="Unread" count={props.unreadCount ?? undefined} />
                    </TabsList>
                  </Tabs>

                  {(availableLabels.length > 0 || props.activeLabel !== null) && (
                    <Select
                      value={props.activeLabel === null ? "all" : String(props.activeLabel)}
                      onValueChange={(value) =>
                        props.onSelectLabel(value === "all" ? null : Number(value))
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Filter by label"
                        className={`ml-auto min-w-0 max-w-[45%] gap-1.5 text-xs ${
                          props.activeLabel !== null
                            ? "border-foreground/25 bg-accent text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        <TagIcon className="h-3.5 w-3.5" />
                        <span className="min-w-0 truncate">
                          {props.activeLabel === null ? "Label" : <SelectValue placeholder="Label" />}
                        </span>
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectItem value="all">All labels</SelectItem>
                        {availableLabels.map((label) => (
                          <SelectItem key={label.id} value={String(label.id)}>
                            {props.selectedMailbox === null
                              ? `${label.name} · ${mailboxAddress.get(label.mailbox_id) ?? ""}`
                              : label.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {props.emptyInbox && (
          <ListState
            title="No conversations yet"
            detail="Email sent to your inboxes will show up here."
          />
        )}

        {props.loading && <ThreadListSkeleton />}

        {props.error && !props.loading && (
          <ListState
            title="Couldn’t load conversations"
            detail="Check your connection and try again."
          />
        )}

        {!props.emptyInbox && !props.loading && !props.error && visibleThreads.length === 0 && (
          <ListState
            title={
              props.search || props.activeLabel !== null
                ? "No matching conversations"
                : props.filter === "unread"
                  ? "No unread conversations"
                  : props.archive
                    ? "Archive is empty"
                    : "Inbox zero"
            }
            detail={
              props.activeLabel !== null
                ? "Try another label or choose All labels."
                : props.search
                  ? "Try a name, subject, or message text."
                  : props.filter === "unread"
                    ? undefined
                    : props.archive
                      ? "Conversations you archive will appear here."
                      : "Nothing needs your attention right now."
            }
          />
        )}

        {visibleThreads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            selected={props.selected === thread.id}
            checked={checked.has(thread.id)}
            selectionMode={selectionMode}
            showMailbox={props.showMailboxChip}
            showArchived={!props.archive}
            onCheckedChange={(value) => toggleChecked(thread.id, value)}
            onClick={() => props.onSelect(thread.id)}
          />
        ))}

        {props.hasMore && !props.loading && (
          <div className="flex justify-center px-4 py-4">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={props.onLoadMore}
              disabled={props.loadingMore}
            >
              {props.loadingMore ? "Loading…" : "Load older conversations"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function FilterTab(props: { value: ThreadFilter; label: string; count?: number }) {
  return (
    <TabsTrigger value={props.value} className="px-2 text-[13px] sm:px-2.5">
      {props.label}
      {props.count ? (
        <span className="text-xs tabular-nums text-muted-foreground">{props.count}</span>
      ) : null}
    </TabsTrigger>
  );
}

function ThreadRow(props: {
  thread: ThreadSummary;
  selected: boolean;
  checked: boolean;
  selectionMode: boolean;
  showMailbox: boolean;
  showArchived: boolean;
  onCheckedChange: (value: boolean) => void;
  onClick: () => void;
}) {
  const { thread } = props;
  const showArchivedBadge = props.showArchived && thread.status === "archived";
  const unread = !thread.is_read;
  const sender = thread.last_from ?? thread.mailbox_address;
  const checkboxId = `thread-select-${thread.id}`;
  const hasDraft =
    thread.pending_draft_count > 0 && thread.last_message_direction === "inbound";
  const revealCheckbox = props.checked || props.selectionMode;

  return (
    <div
      className={`group relative border-b border-border/70 transition-colors ${
        props.selected
          ? "bg-accent"
          : props.checked
            ? "bg-accent/60"
            : "bg-background hover:bg-muted/60"
      }`}
    >
      {unread && (
        <span
          aria-hidden="true"
          className="absolute top-[27px] left-[5px] h-1.5 w-1.5 rounded-full bg-foreground"
        />
      )}
      <button
        type="button"
        onClick={props.onClick}
        aria-current={props.selected ? "true" : undefined}
        className="flex w-full min-w-0 gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="sr-only">{unread ? "Unread conversation. " : ""}</span>
        <EmailAvatar
          email={thread.last_from_address}
          label={sender}
          className={`mt-0.5 h-8 w-8 text-xs transition-opacity duration-150 group-hover:opacity-0 group-has-[[data-slot=checkbox]:focus-visible]:opacity-0 ${
            revealCheckbox ? "opacity-0" : ""
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                unread ? "font-semibold text-foreground" : "font-medium text-foreground/75"
              }`}
            >
              {sender}
            </span>
            <time
              dateTime={thread.last_message_at}
              className={`shrink-0 text-xs tabular-nums ${
                unread ? "font-medium text-foreground" : "text-muted-foreground"
              }`}
            >
              {formatTime(thread.last_message_at)}
            </time>
          </span>
          <span
            className={`mt-0.5 block truncate text-[13px] ${
              unread ? "font-medium text-foreground" : "text-foreground/75"
            }`}
          >
            {thread.subject || "(no subject)"}
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] leading-5 text-muted-foreground">
            {thread.snippet}
          </span>

          {(props.showMailbox || hasDraft || showArchivedBadge || thread.labels.length > 0) && (
            <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              {showArchivedBadge && (
                <Badge
                  variant="outline"
                  className="h-5 shrink-0 gap-1 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground"
                >
                  <ArchiveIcon className="h-3 w-3" />
                  Archived
                </Badge>
              )}
              {thread.labels.map((label) => (
                <Badge
                  key={label.id}
                  variant="outline"
                  className="h-5 shrink-0 gap-1 rounded-md px-1.5 text-[11px] font-normal text-foreground/75"
                >
                  <TagIcon className="h-3 w-3 text-muted-foreground" />
                  {label.name}
                </Badge>
              ))}
              {props.showMailbox && (
                <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
                  {thread.mailbox_address}
                </span>
              )}
              {hasDraft && (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <SparklesIcon className="h-3 w-3" />
                  Draft
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      <label
        htmlFor={checkboxId}
        className={`absolute top-3.5 left-4 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 ${
          revealCheckbox ? "opacity-100" : "opacity-0"
        }`}
      >
        <Checkbox
          id={checkboxId}
          checked={props.checked}
          onCheckedChange={(value) => props.onCheckedChange(value === true)}
          aria-label={`Select conversation with ${sender}`}
        />
      </label>
    </div>
  );
}

function ListState(props: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <InboxIcon className="h-[18px] w-[18px]" />
      </span>
      <p className="mt-3 text-[13px] font-medium text-foreground">{props.title}</p>
      {props.detail && (
        <p className="mt-1 max-w-60 text-[12.5px] leading-5 text-muted-foreground">{props.detail}</p>
      )}
    </div>
  );
}

function ThreadListSkeleton() {
  return (
    <div aria-label="Loading conversations" aria-busy="true">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="flex animate-pulse gap-3 border-b border-border/70 px-4 py-3.5">
          <span className="h-8 w-8 shrink-0 rounded-full bg-muted" />
          <span className="min-w-0 flex-1 space-y-2 pt-0.5">
            <span className="flex justify-between gap-6">
              <span className="block h-3 w-2/5 rounded bg-muted" />
              <span className="block h-3 w-10 rounded bg-muted" />
            </span>
            <span className="block h-3 w-4/5 rounded bg-muted" />
            <span className="block h-2.5 w-full rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </div>
  );
}
