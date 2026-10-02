import type { Mailbox } from "../../shared/types";
import { useEffect, useRef, useState } from "react";
import {
  groupMailboxesByDomain,
  mailboxDomain,
  mailboxLocalPart,
  type MailboxDomainGroup,
} from "../../shared/mailbox-domains";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ContactsIcon,
  InboxIcon,
  SettingsIcon,
  SidebarIcon,
  XIcon,
} from "./Icons";

const COLLAPSED_KEY = "mailroom.sidebarCollapsed";
const INBOXES_COLLAPSED_KEY = "mailroom.sidebarInboxesCollapsed";
const EXPANDED_DOMAINS_KEY = "mailroom.sidebarExpandedDomains";

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

function readExpandedDomains(): Set<string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(EXPANDED_DOMAINS_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeExpandedDomains(domains: Set<string>) {
  try {
    window.localStorage.setItem(EXPANDED_DOMAINS_KEY, JSON.stringify([...domains]));
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

const readCollapsed = () => readFlag(COLLAPSED_KEY);
const writeCollapsed = (collapsed: boolean) => writeFlag(COLLAPSED_KEY, collapsed);

type SidebarNavProps = {
  mailboxes: Mailbox[];
  selected: number | null;
  selectedDomain: string | null;
  activeView: "inbox" | "archive" | "contacts" | "settings";
  onSelect: (id: number | null) => void;
  onSelectDomain: (domain: string) => void;
  onOpenArchive: () => void;
  onOpenContacts: () => void;
  onOpenSettings: () => void;
};

export function Sidebar(props: SidebarNavProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // While collapsed, hovering an item's icon temporarily expands the panel
  // over the content until the pointer leaves it.
  const [peeking, setPeeking] = useState(false);
  const compact = collapsed && !peeking;

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    setPeeking(false);
    writeCollapsed(next);
  };

  return (
    <aside
      className={cn(
        "relative hidden shrink-0 transition-[width] duration-200 ease-out lg:block",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div
        onMouseLeave={() => setPeeking(false)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPeeking(false);
        }}
        className={cn(
          "absolute inset-y-0 left-0 z-30 flex flex-col overflow-hidden border-r bg-sidebar transition-[width,box-shadow] duration-200 ease-out",
          compact ? "w-14" : "w-60",
          collapsed && peeking && "shadow-xl",
        )}
      >
        <SidebarContent
          {...props}
          compact={compact}
          onPeek={collapsed ? () => setPeeking(true) : undefined}
          headerAction={<SidebarToggle collapsed={collapsed} onClick={toggleCollapsed} />}
        />
      </div>
    </aside>
  );
}

/** Slide-out navigation drawer for screens too narrow for the sidebar. */
export function MobileSidebar(
  props: SidebarNavProps & { open: boolean; onOpenChange: (open: boolean) => void },
) {
  const { open, onOpenChange, ...nav } = props;
  const close = (action: () => void) => () => {
    action();
    onOpenChange(false);
  };
  // Swiping the drawer toward the left edge closes it.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 lg:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            swipeStart.current = { x: touch.clientX, y: touch.clientY };
          }}
          onTouchEnd={(event) => {
            const start = swipeStart.current;
            swipeStart.current = null;
            if (!start) return;
            const touch = event.changedTouches[0];
            const dx = touch.clientX - start.x;
            if (dx < -60 && Math.abs(dx) > Math.abs(touch.clientY - start.y)) onOpenChange(false);
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col border-r bg-sidebar pt-[var(--app-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-xl outline-none duration-200 ease-out data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left lg:hidden"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <SidebarContent
            {...nav}
            compact={false}
            onSelect={(id) => close(() => nav.onSelect(id))()}
            onSelectDomain={(domain) => close(() => nav.onSelectDomain(domain))()}
            onOpenArchive={close(nav.onOpenArchive)}
            onOpenContacts={close(nav.onOpenContacts)}
            onOpenSettings={close(nav.onOpenSettings)}
            headerAction={
              <DialogPrimitive.Close
                aria-label="Close navigation"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon className="h-5 w-5" />
              </DialogPrimitive.Close>
            }
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SidebarContent(
  props: SidebarNavProps & {
    compact: boolean;
    onPeek?: () => void;
    headerAction?: React.ReactNode;
  },
) {
  const totalUnread = props.mailboxes.reduce((sum, mailbox) => sum + mailbox.unread_count, 0);
  const { compact, onPeek: peek } = props;
  const [inboxesCollapsed, setInboxesCollapsed] = useState(() => readFlag(INBOXES_COLLAPSED_KEY));
  const showInboxToggle = !compact && props.mailboxes.length > 0;
  const domains = groupMailboxesByDomain(props.mailboxes);
  const [expandedDomains, setExpandedDomains] = useState(readExpandedDomains);
  const selectedAddress = props.mailboxes.find((mailbox) => mailbox.id === props.selected)?.address;
  const selectedMailboxDomain = selectedAddress ? mailboxDomain(selectedAddress) : null;

  const setDomainExpanded = (domain: string, expanded: boolean) => {
    setExpandedDomains((current) => {
      if (current.has(domain) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(domain);
      else next.delete(domain);
      writeExpandedDomains(next);
      return next;
    });
  };

  // Opening an Inbox from elsewhere reveals it under its domain.
  useEffect(() => {
    if (selectedMailboxDomain) setDomainExpanded(selectedMailboxDomain, true);
  }, [selectedMailboxDomain]);

  const toggleInboxes = () => {
    const next = !inboxesCollapsed;
    setInboxesCollapsed(next);
    writeFlag(INBOXES_COLLAPSED_KEY, next);
  };

  return (
    <>
      {compact && props.headerAction ? (
        <div className="flex h-14 shrink-0 items-center pr-2 pl-1.5">{props.headerAction}</div>
      ) : (
        <div className={cn("flex h-14 shrink-0 items-center gap-2.5 pl-4", props.headerAction ? "pr-2" : "pr-4")}>
          <img
            src="/brand/mailroom.png"
            alt=""
            width={20}
            height={20}
            className="h-5 w-5 shrink-0 object-contain dark:invert"
          />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em] whitespace-nowrap text-foreground">
            Mailroom +
          </p>
          {props.headerAction}
        </div>
      )}

      <nav aria-label="Mail" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-4">
        <div className="space-y-px">
          <div className="relative">
            <SidebarItem
              label="All inboxes"
              icon={<InboxIcon className="h-4 w-4" />}
              unread={totalUnread}
              compact={compact}
              active={props.activeView === "inbox" && props.selected === null}
              onClick={() => props.onSelect(null)}
              onPeek={peek}
              trailingSpace={showInboxToggle}
            />
            {showInboxToggle && (
              <button
                type="button"
                onClick={toggleInboxes}
                title={inboxesCollapsed ? "Show inboxes" : "Hide inboxes"}
                aria-label={inboxesCollapsed ? "Show inboxes" : "Hide inboxes"}
                aria-expanded={!inboxesCollapsed}
                aria-controls="sidebar-inboxes"
                className="absolute inset-y-0 right-0 my-auto flex h-7 w-7 touch:h-9 touch:w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronDownIcon
                  className={cn(
                    "h-4 w-4 transition-transform duration-200 ease-out",
                    inboxesCollapsed && "rotate-90",
                  )}
                />
              </button>
            )}
          </div>
          {showInboxToggle && (
            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out",
                inboxesCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
              )}
            >
              <div
                id="sidebar-inboxes"
                role="group"
                aria-label="Inboxes"
                inert={inboxesCollapsed}
                className="ml-[18px] min-h-0 space-y-px overflow-hidden border-l pl-[7px]"
              >
                {domains.map((group) => (
                  <SidebarDomain
                    key={group.domain}
                    group={group}
                    expanded={expandedDomains.has(group.domain)}
                    onToggle={() =>
                      setDomainExpanded(group.domain, !expandedDomains.has(group.domain))
                    }
                    active={
                      props.activeView === "inbox" &&
                      props.selected === null &&
                      props.selectedDomain === group.domain
                    }
                    activeMailbox={props.activeView === "inbox" ? props.selected : null}
                    onSelectDomain={() => props.onSelectDomain(group.domain)}
                    onSelectMailbox={props.onSelect}
                  />
                ))}
              </div>
            </div>
          )}
          <SidebarItem
            label="Archive"
            icon={<ArchiveIcon className="h-4 w-4" />}
            unread={0}
            compact={compact}
            active={props.activeView === "archive"}
            onClick={props.onOpenArchive}
            onPeek={peek}
          />
          <SidebarItem
            label="Contacts"
            icon={<ContactsIcon className="h-4 w-4" />}
            unread={0}
            compact={compact}
            active={props.activeView === "contacts"}
            onClick={props.onOpenContacts}
            onPeek={peek}
          />
        </div>
      </nav>

      <div className="shrink-0 border-t px-2 py-2">
        <SidebarItem
          label="Settings"
          icon={<SettingsIcon className="h-4 w-4" />}
          unread={0}
          compact={compact}
          active={props.activeView === "settings"}
          onClick={props.onOpenSettings}
          onPeek={peek}
        />
      </div>
    </>
  );
}

/** A domain row that opens all of its Inboxes together, with the Inboxes nested below. */
function SidebarDomain(props: {
  group: MailboxDomainGroup<Mailbox>;
  expanded: boolean;
  onToggle: () => void;
  active: boolean;
  activeMailbox: number | null;
  onSelectDomain: () => void;
  onSelectMailbox: (id: number) => void;
}) {
  const { group, expanded } = props;
  const listId = `sidebar-domain-${group.domain.replace(/[^a-z0-9]+/g, "-")}`;
  const toggleLabel = `${expanded ? "Hide" : "Show"} inboxes on ${group.domain}`;

  return (
    <div>
      <div className="relative">
        <SidebarItem
          label={group.domain}
          unread={group.unread_count}
          compact={false}
          active={props.active}
          onClick={props.onSelectDomain}
          trailingSpace
        />
        <button
          type="button"
          onClick={props.onToggle}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          aria-controls={listId}
          className="absolute inset-y-0 right-0 my-auto flex h-7 w-7 touch:h-9 touch:w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronDownIcon
            className={cn("h-4 w-4 transition-transform duration-200 ease-out", !expanded && "rotate-90")}
          />
        </button>
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div
          id={listId}
          role="group"
          aria-label={`Inboxes on ${group.domain}`}
          inert={!expanded}
          className="ml-3 min-h-0 space-y-px overflow-hidden border-l pl-[7px]"
        >
          {group.mailboxes.map((mailbox) => (
            <SidebarItem
              key={mailbox.id}
              label={mailboxLocalPart(mailbox.address)}
              title={mailbox.address}
              unread={mailbox.unread_count}
              compact={false}
              active={props.activeMailbox === mailbox.id}
              onClick={() => props.onSelectMailbox(mailbox.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SidebarToggle(props: { collapsed: boolean; onClick: () => void }) {
  const label = props.collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={label}
      aria-label={label}
      aria-expanded={!props.collapsed}
      className="flex h-8 w-10 shrink-0 items-center rounded-md px-3 text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <SidebarIcon className="h-4 w-4" />
    </button>
  );
}

function SidebarItem(props: {
  label: string;
  /** Tooltip, when it should say more than the label. */
  title?: string;
  icon?: React.ReactNode;
  unread: number;
  compact: boolean;
  active: boolean;
  onClick: () => void;
  onPeek?: () => void;
  /** Leaves room on the right for a control overlaid on the row. */
  trailingSpace?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      onFocus={props.onPeek}
      title={props.title ?? props.label}
      aria-label={props.compact ? props.label : props.title}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center touch:h-10 gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        props.active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
        props.trailingSpace && "pr-8 touch:pr-10",
      )}
    >
      {props.icon && (
        <span
          onMouseEnter={props.onPeek}
          className={cn(
            "relative flex shrink-0 items-center justify-center",
            props.active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
          )}
        >
          {props.icon}
          {props.compact && props.unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-foreground" />
          )}
        </span>
      )}
      {!props.compact && <span className="min-w-0 flex-1 truncate whitespace-nowrap">{props.label}</span>}
      {!props.compact && props.unread > 0 && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            props.active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          )}
        >
          <span className="sr-only">, unread: </span>
          {props.unread > 99 ? "99+" : props.unread}
        </span>
      )}
    </button>
  );
}
