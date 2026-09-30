import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  RemoveFormatting,
  Strikethrough,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  escapeAttribute,
  escapeHtml,
  isBlankRichText,
  linkifyRichText,
  plainTextToLinkedHtml,
  richTextToPlainText,
  sanitizeRichText,
} from "../../shared/rich-text";
import { linkifyText } from "../../shared/linkify";
import {
  addPastedImage,
  isImageFile,
  withPastedImageContentIds,
  withPastedImageUrls,
  withoutUnknownInlineImages,
} from "../pasted-images";

/** Shared look for rich text in the editor and in previews. */
const RICH_TEXT_CONTENT_CLASS =
  "text-sm leading-6 break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_img]:inline-block [&_img]:max-w-full [&_hr]:my-2";

type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "insertUnorderedList"
  | "insertOrderedList";

const FORMAT_BUTTONS: Array<{ command: FormatCommand; label: string; shortcut?: string; icon: ReactNode }> = [
  { command: "bold", label: "Bold", shortcut: "B", icon: <Bold /> },
  { command: "italic", label: "Italic", shortcut: "I", icon: <Italic /> },
  { command: "underline", label: "Underline", shortcut: "U", icon: <Underline /> },
  { command: "strikeThrough", label: "Strikethrough", icon: <Strikethrough /> },
  { command: "insertUnorderedList", label: "Bulleted list", icon: <List /> },
  { command: "insertOrderedList", label: "Numbered list", icon: <ListOrdered /> },
];

/**
 * A small rich-text editor for email bodies and signatures: bold, italic,
 * underline, strikethrough, links and lists. Its output always passes through
 * `sanitizeRichText`, and pasted content is sanitized before insertion. Web
 * and email addresses become links when pasted, and when typed once a space
 * or new line ends them.
 */
export function RichTextEditor(props: {
  id: string;
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  /** "boxed" draws its own border; "bare" sits inside a surrounding card. */
  variant?: "boxed" | "bare";
  className?: string;
  /** Sizing for the editable area, e.g. min and max height. */
  contentClassName?: string;
  /** Called on Cmd/Ctrl+Enter. */
  onSubmitShortcut?: () => void;
  /** Extra controls shown at the right end of the formatting toolbar. */
  toolbarEnd?: ReactNode;
  /** Shown between the toolbar and the editable area. */
  belowToolbar?: ReactNode;
  /** Put the caret on the last line when the editor gains focus, e.g. below a greeting. */
  caretToEndOnFocus?: boolean;
  /**
   * Show pasted or dropped image files in the body. The HTML refers to them
   * through `cid:` links; send them with `pastedImagesIn`.
   */
  inlineImages?: boolean;
}) {
  const variant = props.variant ?? "boxed";
  const editorRef = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string | null>(null);
  const savedRange = useRef<Range | null>(null);
  const draggingFromEditor = useRef(false);
  const [empty, setEmpty] = useState(isBlankRichText(props.value));
  const [active, setActive] = useState<Set<FormatCommand>>(new Set());
  const [linkEditor, setLinkEditor] = useState<{ url: string; error: string | null } | null>(null);

  // Only replace the editable DOM for outside changes (loading, switching
  // inboxes, resetting), never for the user's own typing.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || props.value === lastEmitted.current) return;
    editor.innerHTML = withPastedImageUrls(props.value);
    lastEmitted.current = props.value;
    setEmpty(isBlankRichText(props.value));
  }, [props.value]);

  // Formatting toggled with a collapsed caret (toolbar or Ctrl+B) changes no
  // selection, so the toolbar also refreshes after commands, input and keys.
  const refreshActive = useCallback(() => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
    const next = new Set<FormatCommand>();
    for (const { command } of FORMAT_BUTTONS) {
      try {
        if (document.queryCommandState(command)) next.add(command);
      } catch {
        // queryCommandState is unsupported for some commands in some browsers.
      }
    }
    setActive((current) =>
      current.size === next.size && [...next].every((command) => current.has(command)) ? current : next,
    );
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshActive);
    return () => document.removeEventListener("selectionchange", refreshActive);
  }, [refreshActive]);

  const emit = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const html = sanitizeRichText(withPastedImageContentIds(editor.innerHTML));
    setEmpty(isBlankRichText(html));
    if (html === lastEmitted.current) return;
    lastEmitted.current = html;
    props.onChange(html);
  };

  const run = (command: string, value?: string) => {
    if (props.disabled) return;
    editorRef.current?.focus();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, value);
    emit();
    refreshActive();
  };

  /** Insert pasted or dropped content at the selection, linking any addresses in it. */
  const insertTransfer = (data: DataTransfer) => {
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    const images = props.inlineImages ? [...data.files].filter(isImageFile) : [];
    const pastedHtml = html
      ? withoutUnknownInlineImages(
          sanitizeRichText(withPastedImageContentIds(html)),
          Boolean(props.inlineImages),
        )
      : "";
    // A copied image often comes with HTML that only points at a local file.
    if (images.length > 0 && isBlankRichText(pastedHtml)) {
      insertImages(images);
      return;
    }
    const selection = document.getSelection();
    const pastedLink = linkifyText(text.trim());
    // An address pasted over selected words links those words.
    if (
      selection &&
      !selection.isCollapsed &&
      pastedLink.length === 1 &&
      pastedLink[0]!.type === "link" &&
      selection.toString().trim() !== text.trim()
    ) {
      run("createLink", pastedLink[0]!.href);
    } else if (pastedHtml) {
      run("insertHTML", withPastedImageUrls(linkifyRichText(pastedHtml)));
    } else if (linkifyText(text).some((segment) => segment.type === "link")) {
      run("insertHTML", plainTextToLinkedHtml(text));
    } else if (text) {
      run("insertText", text);
    }
  };

  /** Put image files in the body where the caret is. */
  const insertImages = async (files: File[]) => {
    const editor = editorRef.current;
    const selection = document.getSelection();
    const range =
      editor && selection?.rangeCount && editor.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const added = await Promise.all(files.map((file) => addPastedImage(file)));
    savedRange.current = range;
    restoreSelection();
    run("insertHTML", added.map((image) => `<img src="${escapeAttribute(image.url)}" alt="">`).join(""));
  };

  /** Link addresses the person has finished typing, then report the change. */
  const autolinkAndEmit = (skipAtCaret: boolean) => {
    const editor = editorRef.current;
    if (editor && !props.disabled) autolinkEditor(editor, skipAtCaret);
    emit();
  };

  const openLinkEditor = () => {
    const selection = document.getSelection();
    const editor = editorRef.current;
    if (!editor || props.disabled) return;
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    } else {
      savedRange.current = null;
    }
    const existing = selection?.anchorNode?.parentElement?.closest("a");
    setLinkEditor({
      url: existing && editor.contains(existing) ? existing.getAttribute("href") ?? "" : "",
      error: null,
    });
  };

  const restoreSelection = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    if (savedRange.current) {
      selection.addRange(savedRange.current);
    } else {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.addRange(range);
    }
  };

  const applyLink = () => {
    if (!linkEditor) return;
    const href = normalizeLink(linkEditor.url);
    if (!href) {
      setLinkEditor({ ...linkEditor, error: "Enter a web address, email address or phone number" });
      return;
    }
    restoreSelection();
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) {
      const label = href.replace(/^(mailto|tel):/i, "");
      run("insertHTML", `<a href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`);
    } else {
      run("createLink", href);
    }
    setLinkEditor(null);
  };

  return (
    <div
      className={cn(
        variant === "boxed" &&
          "overflow-hidden rounded-lg border bg-background transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30",
        props.disabled && "opacity-60",
        props.className,
      )}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        aria-controls={props.id}
        className={cn(
          // Phones keep every control on one row; it scrolls sideways only on the narrowest screens.
          "flex flex-wrap items-center gap-0.5 px-1.5 py-1 touch:flex-nowrap touch:gap-0 touch:overflow-x-auto touch:px-1",
          variant === "boxed" ? "border-b bg-muted/30" : "border-b border-border/60",
        )}
      >
        {FORMAT_BUTTONS.map((button, index) => (
          <ToolbarButton
            key={button.command}
            label={button.shortcut ? `${button.label} (Ctrl+${button.shortcut})` : button.label}
            pressed={active.has(button.command)}
            disabled={props.disabled}
            onClick={() => run(button.command)}
            separatorBefore={index === 4}
          >
            {button.icon}
          </ToolbarButton>
        ))}
        <ToolbarButton label="Add link" disabled={props.disabled} onClick={openLinkEditor} separatorBefore>
          <Link2 />
        </ToolbarButton>
        <ToolbarButton label="Remove link" disabled={props.disabled} onClick={() => run("unlink")}>
          <Link2Off />
        </ToolbarButton>
        <ToolbarButton
          label="Clear formatting"
          disabled={props.disabled}
          onClick={() => run("removeFormat")}
          separatorBefore
        >
          <RemoveFormatting />
        </ToolbarButton>
        {props.toolbarEnd && <span className="ml-auto flex shrink-0 items-center pl-1">{props.toolbarEnd}</span>}
      </div>
      {props.belowToolbar}

      {linkEditor && (
        // Not a <form>: the editor usually sits inside one, and forms can't nest.
        <div role="group" aria-label="Link" className="flex flex-wrap items-start gap-2 border-b px-3 py-2">
          <div className="min-w-[12rem] flex-1">
            <Input
              autoFocus
              aria-label="Link address"
              placeholder="https://example.com or name@example.com"
              value={linkEditor.url}
              onChange={(event) => setLinkEditor({ url: event.target.value, error: null })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setLinkEditor(null);
                  restoreSelection();
                }
              }}
              aria-invalid={Boolean(linkEditor.error)}
              className="h-8"
            />
            {linkEditor.error && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {linkEditor.error}
              </p>
            )}
          </div>
          <Button type="button" size="sm" className="h-8" onClick={applyLink}>
            Apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setLinkEditor(null);
              restoreSelection();
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      <div className="relative">
        {empty && props.placeholder && (
          <p
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 truncate px-4 py-3 text-sm leading-6 text-muted-foreground",
              props.contentClassName,
              "min-h-0",
            )}
          >
            {props.placeholder}
          </p>
        )}
        <div
          ref={editorRef}
          id={props.id}
          role="textbox"
          aria-multiline="true"
          aria-label={props.ariaLabel}
          aria-labelledby={props.ariaLabelledBy}
          aria-describedby={props.ariaDescribedBy}
          aria-disabled={props.disabled || undefined}
          contentEditable={!props.disabled}
          suppressContentEditableWarning
          spellCheck
          onInput={(event) => {
            const editor = editorRef.current;
            const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
            if (editor && inputType.startsWith("delete")) discardPendingStyles(editor);
            const data = (event.nativeEvent as InputEvent).data ?? "";
            const endsWord =
              inputType === "insertParagraph" ||
              inputType === "insertLineBreak" ||
              (inputType === "insertText" && /\s$/.test(data));
            if (endsWord) autolinkAndEmit(true);
            else emit();
            refreshActive();
          }}
          onKeyUp={refreshActive}
          onMouseUp={refreshActive}
          onFocus={() => {
            refreshActive();
            if (!props.caretToEndOnFocus) return;
            // After the click that focused the editor has placed its own caret.
            requestAnimationFrame(() => {
              const editor = editorRef.current;
              const selection = document.getSelection();
              if (!editor || !selection || document.activeElement !== editor) return;
              const range = document.createRange();
              const last = editor.lastElementChild;
              const emptyLastLine = Boolean(last && !last.textContent);
              if (last && emptyLastLine) range.setStart(last, 0);
              else range.selectNodeContents(editor);
              range.collapse(emptyLastLine);
              selection.removeAllRanges();
              selection.addRange(range);
            });
          }}
          onBlur={() => autolinkAndEmit(false)}
          onKeyDown={(event) => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
            if (event.key === "Enter" && props.onSubmitShortcut) {
              event.preventDefault();
              autolinkAndEmit(false);
              props.onSubmitShortcut();
              return;
            }
            const key = event.key.toLowerCase();
            if (key === "k") {
              event.preventDefault();
              openLinkEditor();
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            insertTransfer(event.clipboardData);
          }}
          onDragStart={() => {
            draggingFromEditor.current = true;
          }}
          onDragEnd={() => {
            draggingFromEditor.current = false;
          }}
          onDrop={(event) => {
            // Moving text within the editor keeps the browser's own handling.
            if (draggingFromEditor.current) return;
            event.preventDefault();
            if (props.disabled) return;
            const range = rangeAtPoint(event.clientX, event.clientY);
            const selection = document.getSelection();
            if (range && selection && editorRef.current?.contains(range.startContainer)) {
              editorRef.current.focus();
              selection.removeAllRanges();
              selection.addRange(range);
            }
            insertTransfer(event.dataTransfer);
          }}
          className={cn(
            RICH_TEXT_CONTENT_CLASS,
            "overflow-y-auto overscroll-contain px-4 py-3 text-foreground outline-none",
            props.contentClassName ?? "min-h-28",
          )}
        />
      </div>
    </div>
  );
}

/**
 * Read-only rendering of rich text, e.g. a signature under the compose box.
 * With `openLinks`, links are clickable and open in a new tab.
 */
export function RichTextPreview(props: { html: string; className?: string; openLinks?: boolean }) {
  return (
    <div
      className={cn(
        RICH_TEXT_CONTENT_CLASS,
        !props.openLinks && "[&_a]:pointer-events-none",
        props.className,
      )}
      onClick={
        props.openLinks
          ? (event) => {
              const link = (event.target as HTMLElement).closest("a");
              if (!link?.href) return;
              event.preventDefault();
              window.open(link.href, "_blank", "noopener,noreferrer");
            }
          : undefined
      }
      // The HTML passes the allowlist sanitizer, so it cannot carry scripts
      // or event handlers.
      dangerouslySetInnerHTML={{ __html: sanitizeRichText(props.html) }}
    />
  );
}

/** One-line plain-text summary of rich text. */
export function richTextSummary(html: string): string {
  return richTextToPlainText(html).replace(/\s+/g, " ").trim();
}

/**
 * After a deletion, browsers keep the deleted text's bold/italic/strikethrough
 * pending for the next character even when the caret is now in plain text,
 * which makes the toolbar look stuck. Re-placing the caret discards those
 * pending styles, so new text takes the formatting around the caret. An
 * editor emptied by the deletion also loses leftover empty formatting tags.
 */
function discardPendingStyles(editor: HTMLDivElement) {
  const selection = document.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return;
  let range = selection.getRangeAt(0).cloneRange();
  if (editor.innerHTML !== "" && isBlankRichText(sanitizeRichText(editor.innerHTML))) {
    editor.innerHTML = "";
    range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

type CaretTarget = { after: Node } | { node: Node; offset: number };

/**
 * Turn bare web and email addresses in the editor into links. While typing,
 * `skipAtCaret` leaves the address the caret touches alone, since it may not
 * be finished yet; the caret keeps its place in the text.
 */
function autolinkEditor(editor: HTMLElement, skipAtCaret: boolean) {
  const selection = document.getSelection();
  const caret =
    selection?.rangeCount && selection.isCollapsed && editor.contains(selection.anchorNode)
      ? { node: selection.anchorNode, offset: selection.anchorOffset }
      : null;
  // Where the caret goes once the new nodes are in place.
  let caretTarget: CaretTarget | null = null;

  const nodes: Text[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const link = node.parentElement?.closest("a");
    if (!link || !editor.contains(link)) nodes.push(node as Text);
  }

  for (const node of nodes) {
    const segments = linkifyText(node.data);
    if (!segments.some((segment) => segment.type === "link")) continue;
    const parts: Node[] = [];
    let linked = false;
    let nodeCaret: CaretTarget | null = null;
    let position = 0;
    for (const segment of segments) {
      const start = position;
      const end = start + segment.value.length;
      position = end;
      const text = document.createTextNode(segment.value);
      const holdsCaret = caret?.node === node && caret.offset >= start && caret.offset <= end;
      if (segment.type === "link" && !(skipAtCaret && holdsCaret)) {
        const link = document.createElement("a");
        link.setAttribute("href", segment.href);
        link.append(text);
        parts.push(link);
        linked = true;
        if (holdsCaret && !nodeCaret) {
          nodeCaret = caret.offset === end ? { after: link } : { node: text, offset: caret.offset - start };
        }
      } else {
        parts.push(text);
        if (holdsCaret && !nodeCaret) nodeCaret = { node: text, offset: caret.offset - start };
      }
    }
    if (!linked) continue;
    node.replaceWith(...parts);
    if (nodeCaret) caretTarget = nodeCaret;
  }

  if (caretTarget && selection && document.activeElement === editor) {
    const range = document.createRange();
    if ("after" in caretTarget) range.setStartAfter(caretTarget.after);
    else range.setStart(caretTarget.node, caretTarget.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/** The caret position under a point, e.g. where something was dropped. */
function rangeAtPoint(x: number, y: number): Range | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint?.(x, y) ?? null;
}

function ToolbarButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {props.separatorBefore && <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border touch:mx-0.5" />}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={props.label}
        aria-label={props.label}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed}
        disabled={props.disabled}
        // Keep the editor's selection while clicking toolbar buttons.
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onClick}
        className={cn("shrink-0 touch:size-8", props.pressed && "bg-muted text-foreground")}
      >
        {props.children}
      </Button>
    </>
  );
}

function normalizeLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let href = trimmed;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(trimmed)) href = `mailto:${trimmed}`;
  else if (/^\+?[\d\s().-]{6,}$/.test(trimmed)) href = `tel:${trimmed.replace(/[^\d+]/g, "")}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) href = `https://${trimmed}`;
  // Reuse the allowlist so the editor never offers a link the server would drop.
  const sanitized = sanitizeRichText(`<a href="${escapeAttribute(href)}">x</a>`);
  return /href="/.test(sanitized) ? href : null;
}
