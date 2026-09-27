import { useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { MAX_RECIPIENTS_PER_MESSAGE } from "../../shared/email-limits";
import { isEmailAddress, normalizeEmailAddress, splitAddressInput } from "../../shared/recipients";
import { XIcon } from "./Icons";

export interface RecipientInputHandle {
  /** Adds any typed address as a pill. Returns the resulting list, or null when text is left that could not be added. */
  commit(): string[] | null;
}

/** Recipient field that turns each entered address into a removable pill.
 * An address is added on Enter, comma, semicolon, paste or leaving the field.
 * `capacity` is how many more addresses this field may take; at 0 the text
 * input is hidden so only the pills remain.
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
  const errorId = `${props.id}-error`;

  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };

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

  const full = props.capacity <= 0;

  return (
    <div className={`min-w-0 flex-1 ${props.className ?? ""}`}>
      <div
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
            onKeyDown={(event) => {
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
            onBlur={() => add(draftRef.current)}
            className="h-6 min-w-[12ch] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        )}
      </div>
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
