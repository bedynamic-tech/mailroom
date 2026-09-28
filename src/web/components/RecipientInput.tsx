import {
  useDeferredValue,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { MAX_RECIPIENTS_PER_MESSAGE } from "../../shared/email-limits";
import { isEmailAddress, normalizeEmailAddress, splitAddressInput } from "../../shared/recipients";
import type { Contact } from "../../shared/types";
import { fetchContacts } from "../api";
import { EmailAvatar } from "./EmailAvatar";
import { XIcon } from "./Icons";

const MAX_SUGGESTIONS = 6;

export interface RecipientInputHandle {
  /** Adds any typed address as a pill. Returns the resulting list, or null when text is left that could not be added. */
  commit(): string[] | null;
}

/** Recipient field that turns each entered address into a removable pill.
 * An address is added on Enter, comma, semicolon, paste or leaving the field.
 * `capacity` is how many more addresses this field may take; at 0 the text
 * input is hidden so only the pills remain. While typing, matching Contacts
 * are suggested and can be picked with the arrow keys and Enter or Tab.
 */
export function RecipientInput(props: {
  ref?: Ref<RecipientInputHandle>;
  inputRef?: RefObject<HTMLInputElement | null>;
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  capacity: number;
  /** Lowercased addresses already used in other fields of the same message. */
  taken?: ReadonlySet<string>;
  disabled?: boolean;
  placeholder?: string;
  /** Called when the field loses focus with no addresses and nothing typed, so it can collapse. */
  onDismiss?: () => void;
  /** Called on Cmd/Ctrl+Enter when the field is not inside a form that handles it. */
  onSubmitShortcut?: () => void;
  className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const draftRef = useRef("");
  const ownInputRef = useRef<HTMLInputElement>(null);
  const inputRef = props.inputRef ?? ownInputRef;
  const anchorRef = useRef<HTMLDivElement>(null);
  const errorId = `${props.id}-error`;
  const listboxId = `${props.id}-suggestions`;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    setDismissed(false);
    setActiveIndex(0);
  };

  const full = props.capacity <= 0;
  const query = useDeferredValue(draft.trim().toLowerCase());
  const lookup = focused && !full && !props.disabled && query !== "" && !/[\s,;]/.test(query);
  const contacts = useQuery({
    queryKey: ["contacts", "suggest", query],
    queryFn: () => fetchContacts(query, MAX_SUGGESTIONS + 4),
    enabled: lookup,
    staleTime: 30_000,
  });
  const excluded = new Set([
    ...(props.taken ?? []),
    ...props.values.map((value) => value.toLowerCase()),
  ]);
  const suggestions = lookup
    ? (contacts.data ?? [])
        .filter((contact) => !excluded.has(contact.address.toLowerCase()))
        .slice(0, MAX_SUGGESTIONS)
    : [];
  const open = !dismissed && suggestions.length > 0;
  const active = open ? suggestions[Math.min(activeIndex, suggestions.length - 1)] : null;

  const add = (text: string): string[] | null => {
    const tokens = splitAddressInput(text);
    if (tokens.length === 0) {
      updateDraft("");
      setError(null);
      setNotice(null);
      return props.values;
    }
    const next = [...props.values];
    const seen = new Set([...(props.taken ?? []), ...next.map((value) => value.toLowerCase())]);
    const leftover: string[] = [];
    let invalid: string | null = null;
    let duplicate: string | null = null;
    let overLimit = false;
    for (const token of tokens) {
      const address = normalizeEmailAddress(token);
      if (!isEmailAddress(address)) {
        invalid ??= token;
        leftover.push(token);
      } else if (seen.has(address.toLowerCase())) {
        duplicate ??= address;
      } else if (next.length - props.values.length >= props.capacity) {
        // Addresses past the limit are dropped; the error below says why.
        overLimit = true;
      } else {
        seen.add(address.toLowerCase());
        next.push(address);
      }
    }
    if (next.length !== props.values.length) props.onChange(next);
    updateDraft(leftover.join(", "));
    setError(
      invalid
        ? `“${invalid}” is not a valid email address`
        : overLimit
          ? `A message can have at most ${MAX_RECIPIENTS_PER_MESSAGE} recipients`
          : null,
    );
    setNotice(
      !invalid && !overLimit && duplicate ? `${duplicate} is already a recipient` : null,
    );
    return leftover.length ? null : next;
  };

  useImperativeHandle(props.ref, () => ({ commit: () => add(draftRef.current) }));

  const remove = (index: number) => {
    props.onChange(props.values.filter((_, i) => i !== index));
    setError(null);
    setNotice(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const pick = (contact: Contact) => {
    add(contact.address);
    inputRef.current?.focus();
  };

  return (
    <div className={`min-w-0 flex-1 ${props.className ?? ""}`}>
      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) setDismissed(true);
        }}
      >
        <PopoverPrimitive.Anchor asChild>
          <div
            ref={anchorRef}
            className="flex min-w-0 flex-wrap items-center gap-1.5 py-1.5"
            onClick={(event) => {
              if (event.target === event.currentTarget) inputRef.current?.focus();
            }}
          >
            {props.values.map((address, index) => (
              <span
                key={address}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs text-foreground"
              >
                <span className="min-w-0 truncate" title={address}>{address}</span>
                <button
                  type="button"
                  disabled={props.disabled}
                  aria-label={`Remove ${address} from ${props.label}`}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none"
                  onClick={() => remove(index)}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
            {!full && (
              <input
                ref={inputRef}
                id={props.id}
                type="email"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
                value={draft}
                disabled={props.disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                placeholder={props.values.length === 0 ? props.placeholder : undefined}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/[,;]/.test(value)) add(value);
                  else {
                    updateDraft(value);
                    if (error) setError(null);
                    if (notice) setNotice(null);
                  }
                }}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData("text");
                  if (!/[\s,;]/.test(pasted.trim())) return;
                  event.preventDefault();
                  add(`${draftRef.current} ${pasted}`);
                }}
                onFocus={() => setFocused(true)}
                onKeyDown={(event) => {
                  if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setActiveIndex(
                      (Math.min(activeIndex, suggestions.length - 1) + step + suggestions.length) %
                        suggestions.length,
                    );
                    return;
                  }
                  if (
                    active &&
                    ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) ||
                      (event.key === "Tab" && !event.shiftKey))
                  ) {
                    event.preventDefault();
                    pick(active);
                    return;
                  }
                  if (event.key === "Enter") {
                    if (event.metaKey || event.ctrlKey) {
                      if (props.onSubmitShortcut) {
                        event.preventDefault();
                        props.onSubmitShortcut();
                      }
                      return;
                    }
                    event.preventDefault();
                    add(draftRef.current);
                  } else if (event.key === "Backspace" && !draftRef.current && props.values.length > 0) {
                    event.preventDefault();
                    props.onChange(props.values.slice(0, -1));
                  }
                }}
                onBlur={() => {
                  setFocused(false);
                  if (add(draftRef.current)?.length === 0) props.onDismiss?.();
                }}
                className={cn("h-7 flex-1 bg-transparent text-sm text-foreground md:h-6 outline-none placeholder:text-muted-foreground", props.values.length > 0 ? "min-w-[6ch]" : "min-w-[12ch]")}
              />
            )}
          </div>
        </PopoverPrimitive.Anchor>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            side="bottom"
            sideOffset={2}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              // Clicking back into this field keeps the suggestions open.
              if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
            }}
            className="z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            <ul id={listboxId} role="listbox" aria-label={`Contacts for ${props.label}`}>
              {suggestions.map((contact) => (
                <li
                  key={contact.id}
                  id={`${listboxId}-${contact.id}`}
                  role="option"
                  aria-selected={contact === active}
                  // Keep focus in the field so picking does not trigger its blur handling.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveIndex(suggestions.indexOf(contact))}
                  onClick={() => pick(contact)}
                  className={cn(
                    "flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5",
                    contact === active && "bg-accent text-accent-foreground",
                  )}
                >
                  <EmailAvatar
                    email={contact.address}
                    label={contact.name ?? contact.address}
                    className="h-6 w-6 text-xs"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {contact.name ?? contact.address}
                    </span>
                    {(contact.name || contact.company) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {contact.name ? contact.address : ""}
                        {contact.name && contact.company ? " · " : ""}
                        {contact.company ?? ""}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      {error && (
        <p id={errorId} role="alert" className="pb-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      {!error && notice && (
        <p role="status" className="pb-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
