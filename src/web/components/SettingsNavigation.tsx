import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon } from "./Icons";

export type SettingsSection = "general" | "notifications" | "inboxes" | "contacts" | "rules" | "spam" | "ai";

export function SettingsHeader(props: {
  active: SettingsSection;
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenNotifications: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenRules: () => void;
  onOpenSpam: () => void;
  onOpenAi: () => void;
}) {
  const sections: { id: SettingsSection; label: string; open: () => void }[] = [
    { id: "general", label: "General", open: props.onOpenGeneral },
    { id: "notifications", label: "Notifications", open: props.onOpenNotifications },
    { id: "inboxes", label: "Inboxes", open: props.onOpenInboxes },
    { id: "contacts", label: "Contacts", open: props.onOpenContacts },
    { id: "rules", label: "Rules", open: props.onOpenRules },
    { id: "spam", label: "Spam", open: props.onOpenSpam },
    { id: "ai", label: "AI", open: props.onOpenAi },
  ];
  const activeLabel = sections.find((section) => section.id === props.active)?.label ?? "General";

  return (
    <header className="shrink-0 border-b bg-background px-4 md:px-6">
      <div className="flex h-14 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1.5 lg:hidden"
          aria-label="Back to inbox"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <h1 className="text-base font-semibold tracking-[-0.015em] text-foreground">Settings</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="-mr-1 ml-auto gap-1.5 md:hidden"
              aria-label={`Settings section: ${activeLabel}`}
            >
              {activeLabel}
              <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {sections.map((section) => (
              <DropdownMenuItem
                key={section.id}
                onSelect={section.open}
                aria-current={props.active === section.id ? "page" : undefined}
                className={cn(props.active === section.id && "font-medium")}
              >
                <span className="flex-1">{section.label}</span>
                {props.active === section.id && <CheckIcon className="text-foreground" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <nav
        aria-label="Settings sections"
        className="-mb-px hidden gap-5 overflow-x-auto [scrollbar-width:none] md:flex"
      >
        {sections.map((section) => (
          <SettingsTab
            key={section.id}
            active={props.active === section.id}
            onClick={section.open}
          >
            {section.label}
          </SettingsTab>
        ))}
      </nav>
    </header>
  );
}

function SettingsTab(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "relative shrink-0 rounded-t-sm pb-2.5 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
        props.active
          ? "font-medium text-foreground after:bg-foreground"
          : "text-muted-foreground after:bg-transparent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function SettingsPage(props: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[780px] space-y-10 px-4 py-6 md:px-6 md:py-8">{props.children}</div>
    </div>
  );
}

export function SettingsBlock(props: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={props.id}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={props.id} className="text-sm font-semibold text-foreground">
            {props.title}
          </h2>
          {props.description && (
            <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">
              {props.description}
            </p>
          )}
        </div>
        {props.action && <div className="shrink-0">{props.action}</div>}
      </div>
      {props.children}
    </section>
  );
}

export function SettingsPanel(props: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-background", props.className)}>
      {props.children}
    </div>
  );
}
