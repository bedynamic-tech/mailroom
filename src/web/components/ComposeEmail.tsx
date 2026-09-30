import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { composeEmail, ComposeRequestError, fetchDomains, fetchMailboxes } from "../api";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES, MAX_MESSAGE_CHARS, MAX_RECIPIENTS_PER_MESSAGE, MAX_SUBJECT_CHARS } from "../../shared/email-limits";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import { PaperclipIcon, SendIcon, XIcon } from "./Icons";
import { RichTextEditor, RichTextPreview } from "./RichTextEditor";
import { isBlankRichText, richTextToPlainText, sanitizeRichText } from "../../shared/rich-text";
import { pastedImagesIn } from "../pasted-images";

type OpenCompose = (mailboxId: number | null, options?: { to?: string }) => void;

const ComposeContext = createContext<OpenCompose>(() => {});
export const useCompose = () => useContext(ComposeContext);

/** Extends the inbox's existing Geist/neutral controls with a focused letter editor.
 * Address rows lead into an unboxed writing area; send/attachments stay in the
 * footer. Closing preserves the draft for this page session, including files.
 */
/** Phones get the full-screen editor, where field names sit inside the fields. */
const PHONE_QUERY = "(max-width: 639px)";

function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

export function ComposeEmailProvider({ children }: { children: ReactNode }) {
  const phone = useIsPhone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preferredMailbox, setPreferredMailbox] = useState<number | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  // Cc/Bcc rows stay collapsed unless they hold an address or are being filled in.
  const [addingCc, setAddingCc] = useState(false);
  const [addingBcc, setAddingBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const attempt = useRef<Parameters<typeof composeEmail>[0] | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const bccRef = useRef<HTMLInputElement>(null);
  const toField = useRef<RecipientInputHandle>(null);
  const ccField = useRef<RecipientInputHandle>(null);
  const bccField = useRef<RecipientInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes, enabled: open });
  const domains = useQuery({ queryKey: ["domains"], queryFn: fetchDomains, enabled: open });
  const hasDraft = Boolean(to.length || cc.length || bcc.length || subject || !isBlankRichText(html) || files.length);
  const showCc = addingCc || cc.length > 0;
  const showBcc = addingBcc || bcc.length > 0;
  const remaining = MAX_RECIPIENTS_PER_MESSAGE - to.length - cc.length - bcc.length;
  // Copies never take the last slot while the message still needs its To recipient.
  const copyCapacity = remaining - (to.length === 0 ? 1 : 0);
  const lowered = (values: string[]) => values.map((value) => value.toLowerCase());
  const takenBy = (...lists: string[][]) => new Set(lists.flatMap(lowered));
  const locked = sending || uncertain;
  const activeDomains = new Set(domains.data?.filter((domain) => domain.status === "active").map((domain) => domain.name.toLowerCase()));
  const available = (mailboxes.data ?? []).filter((mailbox) => activeDomains.has(mailbox.address.split("@")[1]?.toLowerCase()));
  const sender = available.find((mailbox) => String(mailbox.id) === mailboxId);
  const ready = Boolean(sender);
  const loading = mailboxes.isLoading || domains.isLoading;
  const loadError = mailboxes.isError || domains.isError;

  useEffect(() => {
    if (!open || hasDraft || locked) return;
    const preferred = available.find((mailbox) => mailbox.id === preferredMailbox) ?? available[0];
    setMailboxId(preferred ? String(preferred.id) : "");
    // Only choose the initial sender when opening or receiving inbox data.
    // A user's selection while the editor is open must not reset itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferredMailbox, mailboxes.data, domains.data]);

  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDraft]);

  const reset = () => {
    setTo([]); setCc([]); setBcc([]); setAddingCc(false); setAddingBcc(false); setSubject(""); setHtml(""); setFiles([]);
    setNotice(null); setFileError(null); setFailed(false); setUncertain(false);
    setConfirmDiscard(false); attempt.current = null;
  };

  const send = async () => {
    if (inFlight.current || confirmDiscard) return;
    let recipients = { to, cc, bcc };
    if (!uncertain) {
      if (!ready) return;
      // Add any address still being typed; stop if one of them is invalid.
      const committed = [toField.current?.commit() ?? to, ccField.current?.commit() ?? cc, bccField.current?.commit() ?? bcc];
      if (committed.some((list) => list === null)) return;
      const [nextTo, nextCc, nextBcc] = committed as string[][];
      recipients = { to: nextTo, cc: nextCc, bcc: nextBcc };
      if (recipients.to.length === 0) {
        setNotice("Add a recipient before sending.");
        toRef.current?.focus();
        return;
      }
      if (!formRef.current?.reportValidity()) return;
      if (isBlankRichText(html) && files.length === 0) {
        setNotice("Write a message or attach a file before sending.");
        return;
      }
      const images = pastedImagesIn(sanitizeRichText(html)).map((image) => image.file);
      if (files.length + images.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        setNotice("Send up to 10 attachments and pasted images per message.");
        return;
      }
      if ([...files, ...images].reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
        setNotice("Attachments and pasted images must total 3 MB or less.");
        return;
      }
      if (richTextToPlainText(html).length > MAX_MESSAGE_CHARS) {
        setNotice(`Keep the message under ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`);
        return;
      }
    }
    if (!attempt.current) {
      const body = isBlankRichText(html) ? "" : sanitizeRichText(html);
      attempt.current = { mailboxId: Number(mailboxId), to: recipients.to[0]!, cc: recipients.cc, bcc: recipients.bcc, subject: subject.trim(), text: body ? richTextToPlainText(body) : "", html: body || undefined, files: [...files], inlineImages: pastedImagesIn(body), attemptId: crypto.randomUUID() };
    }
    inFlight.current = true;
    setSending(true); setNotice(null); setFailed(false);
    try {
      const result = await composeEmail(attempt.current);
      if (result.status === "sent" && result.conversation_id !== null) {
        const sender = attempt.current.mailboxId;
        reset(); setOpen(false);
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
        navigate(`/mailboxes/${sender}/threads/${result.conversation_id}`);
      } else if (result.status === "failed") {
        setUncertain(false); setFailed(true); attempt.current = null;
        setNotice(result.error ?? "The email provider rejected this message. You can edit it and try again.");
      } else {
        setUncertain(true);
        setNotice("Send confirmation is pending. Check again before starting another message; this will not send a duplicate.");
      }
    } catch (error) {
      if (!uncertain && error instanceof ComposeRequestError && error.status >= 400 && error.status < 500) {
        setUncertain(false); attempt.current = null;
        setNotice(error.message);
      } else {
        setUncertain(true);
        setNotice("The connection was interrupted, so we couldn’t confirm delivery. Check the same send again to avoid duplicates.");
      }
    } finally {
      inFlight.current = false; setSending(false);
    }
  };

  const addFiles = (selected: FileList | null) => {
    if (!selected) return;
    const next = [...files, ...selected];
    if (next.length > MAX_ATTACHMENTS_PER_MESSAGE) setFileError("Attach up to 10 files per message.");
    else if (next.some((file) => file.size === 0)) setFileError("Empty files cannot be attached.");
    else if (next.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) setFileError("Attachments must total 3 MB or less.");
    else { setFiles(next); setFileError(null); }
    if (fileInput.current) fileInput.current.value = "";
  };

  const close = () => { if (!inFlight.current) { setOpen(false); setConfirmDiscard(false); } };
  const setup = () => { close(); navigate("/settings/inboxes"); };

  return (
    <ComposeContext.Provider value={(id, options) => {
      setPreferredMailbox(id);
      // Prefill the recipient only when it would not disturb a draft in progress.
      const address = options?.to;
      if (address && !locked && to.length === 0 && !takenBy(cc, bcc).has(address.toLowerCase())) setTo([address]);
      setOpen(true);
    }}>
      {children}
      <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
        <DialogContent
          showCloseButton={false}
          className="inset-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[calc(100dvh_-_2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:ring-1"
          onOpenAutoFocus={(event) => {
            if (toRef.current && !toRef.current.matches(":disabled")) { event.preventDefault(); toRef.current.focus(); }
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <header className="flex shrink-0 items-center justify-between border-b py-3 pr-2 pl-4 pt-[max(0.75rem,var(--app-inset-top))] sm:px-5 sm:py-4">
            <DialogTitle>New message</DialogTitle>
            <DialogDescription className="sr-only">Write a new email. Closing keeps your draft until you leave or reload this page.</DialogDescription>
            <Button type="button" variant="ghost" size="icon" onClick={close} disabled={sending} aria-label="Close and keep draft" title="Close and keep draft">
              <XIcon className="h-4 w-4" />
            </Button>
          </header>
          <form ref={formRef} className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void send(); }} onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
          }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-5">
              {loading ? <p className="py-4 text-sm text-muted-foreground" role="status">Loading your inboxes…</p> : loadError ? (
                <div className="py-4 text-sm" role="alert">Couldn’t load your sending inboxes. <Button type="button" variant="link" onClick={() => { void mailboxes.refetch(); void domains.refetch(); }}>Try again</Button></div>
              ) : available.length === 0 ? (
                <div className="py-4 text-sm"><p>Set up an inbox and activate its domain before sending.</p><Button type="button" variant="link" className="px-0" onClick={setup}>Set up an inbox</Button></div>
              ) : null}
              <fieldset disabled={locked || loading || loadError || available.length === 0} className="min-w-0 disabled:opacity-60">
                <div className="flex min-h-12 items-center gap-2 border-b sm:gap-3">
                  <label htmlFor="compose-from" className="shrink-0 text-sm text-muted-foreground">From</label>
                  <select id="compose-from" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)} required className="min-w-0 flex-1 rounded-md bg-transparent py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="" disabled>Choose an inbox</option>
                    {available.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.address}</option>)}
                  </select>
                </div>
                <div className="flex min-h-12 items-start gap-2 border-b sm:gap-3">
                  <label htmlFor="compose-to" className="shrink-0 py-[13px] text-sm text-muted-foreground max-sm:sr-only">To</label>
                  <RecipientInput ref={toField} inputRef={toRef} id="compose-to" label="To" values={to} onChange={setTo} capacity={Math.min(1 - to.length, remaining)} taken={takenBy(cc, bcc)} placeholder={phone ? "To" : "recipient@example.com"} className="py-[3px] sm:py-[5px]" />
                  {(!showCc || !showBcc) && (
                    <span className="flex h-[47px] shrink-0 items-center">
                      {!showCc && <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" aria-label="Add Cc recipients" onClick={() => { setAddingCc(true); requestAnimationFrame(() => ccRef.current?.focus()); }}>Cc</Button>}
                      {!showBcc && <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" aria-label="Add Bcc recipients" onClick={() => { setAddingBcc(true); requestAnimationFrame(() => bccRef.current?.focus()); }}>Bcc</Button>}
                    </span>
                  )}
                </div>
                {showCc && (
                  <div className="flex min-h-12 items-start gap-2 border-b sm:gap-3">
                    <label htmlFor="compose-cc" className="shrink-0 py-[13px] text-sm text-muted-foreground max-sm:sr-only">Cc</label>
                    <RecipientInput ref={ccField} inputRef={ccRef} id="compose-cc" label="Cc" values={cc} onChange={setCc} capacity={copyCapacity} taken={takenBy(to, bcc)} placeholder={phone ? "Cc" : "Add Cc recipients"} onDismiss={() => setAddingCc(false)} className="py-[3px] sm:py-[5px]" />
                  </div>
                )}
                {showBcc && (
                  <div className="flex min-h-12 items-start gap-2 border-b sm:gap-3">
                    <label htmlFor="compose-bcc" className="shrink-0 py-[13px] text-sm text-muted-foreground max-sm:sr-only">Bcc</label>
                    <RecipientInput ref={bccField} inputRef={bccRef} id="compose-bcc" label="Bcc" values={bcc} onChange={setBcc} capacity={copyCapacity} taken={takenBy(to, cc)} placeholder={phone ? "Bcc" : "Add Bcc recipients"} onDismiss={() => setAddingBcc(false)} className="py-[3px] sm:py-[5px]" />
                  </div>
                )}
                {copyCapacity <= 0 && (
                  <p role="status" className="border-b py-2 text-xs text-muted-foreground">
                    This message has reached the limit of {MAX_RECIPIENTS_PER_MESSAGE} recipients.
                  </p>
                )}
                <div className="flex min-h-12 items-center gap-2 border-b sm:gap-3">
                  <label htmlFor="compose-subject" className="shrink-0 text-sm text-muted-foreground max-sm:sr-only">Subject</label>
                  <Input id="compose-subject" required maxLength={MAX_SUBJECT_CHARS} placeholder={phone ? "Subject" : "Add a subject"} value={subject} onChange={(event) => setSubject(event.target.value)} className="min-w-0 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" />
                </div>
                <RichTextEditor id="compose-body" ariaLabel="Message" value={html} onChange={setHtml} inlineImages variant="bare" placeholder="Write your message…" className="mt-1" contentClassName="min-h-44 px-0 sm:min-h-64 sm:px-2" />
                {sender?.effective_signature_html && (
                  <div className="mb-4 text-muted-foreground sm:px-2">
                    <p className="mb-1 text-xs">Signature added when sent</p>
                    <RichTextPreview html={sender.effective_signature_html} />
                  </div>
                )}
              </fieldset>
              {files.length > 0 && <ul aria-label="Attachments" className="mb-4 space-y-1.5">{files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
                  <PaperclipIcon className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                  <span className="shrink-0 text-muted-foreground">{Math.max(1, Math.ceil(file.size / 1024))} KB</span>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={locked} aria-label={`Remove ${file.name}`} onClick={() => { setFiles(files.filter((_, i) => i !== index)); setFileError(null); }}><XIcon className="h-3.5 w-3.5" /></Button>
                </li>
              ))}</ul>}
              {fileError && <p role="alert" className="mb-3 text-sm text-destructive">{fileError}</p>}
              {notice && <p role="alert" className={`mb-4 text-sm leading-5 ${uncertain ? "text-muted-foreground" : "text-destructive"}`}>{notice}</p>}
            </div>
            <footer className="shrink-0 border-t bg-muted/30 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-4">
              {confirmDiscard ? (
                <div role="alert" className="flex flex-wrap items-center gap-2"><p className="mr-auto text-sm">Discard this unsent message?</p><Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>Keep writing</Button><Button type="button" variant="destructive" onClick={() => { reset(); setOpen(false); }}>Discard message</Button></div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={sending || (!uncertain && (!ready || loading || loadError))}><SendIcon className="h-4 w-4" />{sending ? (uncertain ? "Checking…" : "Sending…") : uncertain ? "Check send status" : failed ? "Send again" : "Send"}</Button>
                  <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => addFiles(event.target.files)} tabIndex={-1} />
                  <Button type="button" variant="ghost" size="icon" disabled={locked} aria-label="Attach files" title="Attach files (up to 10 files, 3 MB total)" onClick={() => fileInput.current?.click()}><PaperclipIcon className="h-4 w-4" /></Button>
                  <span className="hidden text-xs text-muted-foreground sm:inline">3 MB attachment limit</span>
                  <Button type="button" variant="ghost" disabled={locked} className="ml-auto text-muted-foreground" onClick={() => hasDraft ? setConfirmDiscard(true) : (reset(), setOpen(false))}>Discard</Button>
                </div>
              )}
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </ComposeContext.Provider>
  );
}
