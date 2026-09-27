import type { Mailbox } from "../../shared/types";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ArchiveIcon, ContactsIcon, InboxIcon, SettingsIcon, SidebarIcon } from "./Icons";

const COLLAPSED_KEY = "mailroom.sidebarCollapsed";

function readCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}

export function Sidebar(props: {
  mailboxes: Mailbox[];
  selected: number | null;
  activeView: "inbox" | "archive" | "contacts" | "settings";
  onSelect: (id: number | null) => void;
  onOpenArchive: () => void;
  onOpenContacts: () => void;
  onOpenSettings: () => void;
}) {
  const totalUnread = props.mailboxes.reduce((sum, mailbox) => sum + mailbox.unread_count, 0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // While collapsed, hovering an item's icon temporarily expands the panel
  // over the content until the pointer leaves it.
  const [peeking, setPeeking] = useState(false);
  const compact = collapsed && !peeking;
  const peek = collapsed ? () => setPeeking(true) : undefined;

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
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <img
            src="/brand/mailroom.png"
            alt=""
            width={20}
            height={20}
            className="h-5 w-5 shrink-0 object-contain"
          />
          {!compact && (
            <p className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] whitespace-nowrap text-foreground">
              Mailroom
            </p>
          )}
        </div>

        <nav aria-label="Mail" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-1 pb-4">
          <div className="space-y-px">
            <SidebarItem
              label="All inboxes"
              icon={<InboxIcon className="h-4 w-4" />}
              unread={totalUnread}
              compact={compact}
              active={props.activeView === "inbox" && props.selected === null}
              onClick={() => props.onSelect(null)}
              onPeek={peek}
            />
            {!compact && props.mailboxes.length > 0 && (
              <div role="group" aria-label="Inboxes" className="ml-[18px] space-y-px border-l pl-[7px]">
                {props.mailboxes.map((mailbox) => (
                  <SidebarItem
                    key={mailbox.id}
                    label={mailbox.address}
                    unread={mailbox.unread_count}
                    compact={false}
                    active={props.activeView === "inbox" && props.selected === mailbox.id}
                    onClick={() => props.onSelect(mailbox.id)}
                  />
                ))}
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

        <div className="shrink-0 space-y-px border-t px-2 py-2">
          <SidebarItem
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            icon={<SidebarIcon className="h-4 w-4" />}
            unread={0}
            compact={compact}
            active={false}
            onClick={toggleCollapsed}
          />
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
      </div>
    </aside>
  );
}

function SidebarItem(props: {
  label: string;
  icon?: React.ReactNode;
  unread: number;
  compact: boolean;
  active: boolean;
  onClick: () => void;
  onPeek?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      onFocus={props.onPeek}
      title={props.label}
      aria-label={props.compact ? props.label : undefined}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        props.active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
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
