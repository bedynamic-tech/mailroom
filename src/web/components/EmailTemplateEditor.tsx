import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { EmailNotificationTemplate } from "../../shared/types";
import {
  DEFAULT_NOTIFICATION_BODY,
  DEFAULT_NOTIFICATION_FROM_NAME,
  DEFAULT_NOTIFICATION_SUBJECT,
  NOTIFICATION_LIMITS,
  NOTIFICATION_PLACEHOLDERS,
  renderNotification,
  unknownPlaceholders,
  type NotificationValues,
} from "../../shared/notification-template";
import { fetchMailboxes, updateEmailNotificationTemplate } from "../api";

const RECEIVING_INBOX = "receiving";

type FieldName = "fromName" | "subject" | "body";

export function EmailTemplateEditor(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: EmailNotificationTemplate;
  recipient: string | null;
}) {
  const queryClient = useQueryClient();
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes, enabled: props.open });

  const [fromName, setFromName] = useState(props.template.from_name);
  const [fromMailbox, setFromMailbox] = useState(toSelectValue(props.template.from_mailbox_id));
  const [subject, setSubject] = useState(props.template.subject);
  const [body, setBody] = useState(props.template.body);
  const [activeField, setActiveField] = useState<FieldName>("body");
  const fields = {
    fromName: useRef<HTMLInputElement>(null),
    subject: useRef<HTMLInputElement>(null),
    body: useRef<HTMLTextAreaElement>(null),
  };
  const setters = { fromName: setFromName, subject: setSubject, body: setBody };

  // Start from the saved template each time the dialog opens.
  useEffect(() => {
    if (!props.open) return;
    setFromName(props.template.from_name);
    setFromMailbox(toSelectValue(props.template.from_mailbox_id));
    setSubject(props.template.subject);
    setBody(props.template.body);
    save.reset();
  }, [props.open]);

  const save = useMutation({
    mutationFn: () =>
      updateEmailNotificationTemplate({
        from_name: fromName.trim(),
        from_mailbox_id: selectedFrom === RECEIVING_INBOX ? null : Number(selectedFrom),
        subject,
        body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings", "general"] });
      props.onOpenChange(false);
    },
  });

  const insertPlaceholder = (key: string) => {
    const token = `{{${key}}}`;
    const element = fields[activeField].current;
    const setValue = setters[activeField];
    if (!element) return;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    setValue(element.value.slice(0, start) + token + element.value.slice(end));
    pendingCursor.current = { field: activeField, position: start + token.length };
  };

  // Place the cursor after an inserted placeholder once React has committed the new value.
  const pendingCursor = useRef<{ field: FieldName; position: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCursor.current;
    if (!pending) return;
    pendingCursor.current = null;
    const element = fields[pending.field].current;
    element?.focus();
    element?.setSelectionRange(pending.position, pending.position);
  }, [fromName, subject, body]);

  const resetToDefault = () => {
    setFromName(DEFAULT_NOTIFICATION_FROM_NAME);
    setFromMailbox(RECEIVING_INBOX);
    setSubject(DEFAULT_NOTIFICATION_SUBJECT);
    setBody(DEFAULT_NOTIFICATION_BODY);
  };

  const inboxes = mailboxes.data ?? [];
  const chosenInbox = inboxes.find((mailbox) => String(mailbox.id) === fromMailbox);
  // A saved sending Inbox that was deleted falls back to the receiving Inbox, as on the server.
  const selectedFrom = mailboxes.isSuccess && !chosenInbox ? RECEIVING_INBOX : fromMailbox;
  const sampleInbox = inboxes[0]?.address ?? "support@example.com";
  const values: NotificationValues = {
    sender_name: "Alice Customer",
    sender_email: "alice@example.com",
    subject: "Refund request for order #1042",
    preview: "Hi there, I ordered the wrong size last week and would like to return it for a refund.",
    inbox: sampleInbox,
    link: `${window.location.origin}/inbox/123`,
  };
  const preview = renderNotification({ fromName, subject, body }, values);
  const previewFromAddress = chosenInbox?.address ?? sampleInbox;

  const unknown = unknownPlaceholders(`${fromName}\n${subject}\n${body}`);
  const localError =
    unknown.length > 0
      ? `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((key) => `{{${key}}}`).join(", ")}`
      : /[\r\n"<>]/.test(fromName)
        ? "Sender name can't contain quotes or angle brackets."
        : null;
  const canSave = !save.isPending && !localError && subject.trim() !== "" && body.trim() !== "";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Customize notification email</DialogTitle>
            <DialogDescription>
              Placeholders like <code className="text-foreground">{"{{subject}}"}</code> are
              replaced with details of each new email. Lines whose placeholders are all empty
              are left out.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-6 py-5 lg:grid-cols-2">
            <div className="min-w-0 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <EditorField label="Sender name" htmlFor="notification-from-name">
                  <Input
                    id="notification-from-name"
                    ref={fields.fromName}
                    value={fromName}
                    maxLength={NOTIFICATION_LIMITS.fromName}
                    onChange={(event) => setFromName(event.target.value)}
                    onFocus={() => setActiveField("fromName")}
                    placeholder="Mailroom"
                  />
                </EditorField>
                <EditorField label="Send from" htmlFor="notification-from-inbox">
                  <Select value={selectedFrom} onValueChange={setFromMailbox}>
                    <SelectTrigger id="notification-from-inbox" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={RECEIVING_INBOX}>Inbox that received it</SelectItem>
                      {inboxes.map((mailbox) => (
                        <SelectItem key={mailbox.id} value={String(mailbox.id)}>
                          {mailbox.address}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </EditorField>
              </div>

              <EditorField label="Subject" htmlFor="notification-subject">
                <Input
                  id="notification-subject"
                  ref={fields.subject}
                  value={subject}
                  maxLength={NOTIFICATION_LIMITS.subject}
                  onChange={(event) => setSubject(event.target.value)}
                  onFocus={() => setActiveField("subject")}
                  required
                />
              </EditorField>

              <EditorField label="Body" htmlFor="notification-body">
                <Textarea
                  id="notification-body"
                  ref={fields.body}
                  value={body}
                  maxLength={NOTIFICATION_LIMITS.body}
                  onChange={(event) => setBody(event.target.value)}
                  onFocus={() => setActiveField("body")}
                  className="min-h-56 font-mono text-sm"
                  required
                />
              </EditorField>

              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Insert into {FIELD_LABELS[activeField].toLowerCase()}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {NOTIFICATION_PLACEHOLDERS.map((placeholder) => (
                    <button
                      key={placeholder.key}
                      type="button"
                      title={placeholder.description}
                      // Keep focus (and the cursor position) in the field being edited.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertPlaceholder(placeholder.key)}
                      className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {`{{${placeholder.key}}}`}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Preview with sample email</p>
              <div className="mt-2 overflow-hidden rounded-lg border bg-background">
                <dl className="space-y-1 border-b px-3 py-2.5 text-sm">
                  <PreviewRow label="From">
                    {preview.fromName ? `${preview.fromName} <${previewFromAddress}>` : previewFromAddress}
                  </PreviewRow>
                  <PreviewRow label="To">{props.recipient ?? "you@example.com"}</PreviewRow>
                  <PreviewRow label="Subject">
                    <span className="font-medium">{preview.subject}</span>
                  </PreviewRow>
                </dl>
                <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm leading-5 text-foreground">
                  {preview.body}
                </pre>
              </div>
            </div>
          </div>

          <DialogFooter className="sm:items-center sm:justify-between">
            <Button type="button" variant="ghost" onClick={resetToDefault} disabled={save.isPending}>
              Reset to default
            </Button>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {(localError || save.error) && (
                <p className="text-sm text-destructive sm:mr-2" role="alert">
                  {localError ?? save.error?.message ?? "Couldn’t save the template."}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSave}>
                  {save.isPending ? "Saving…" : "Save template"}
                </Button>
              </div>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_LABELS: Record<FieldName, string> = {
  fromName: "Sender name",
  subject: "Subject",
  body: "Body",
};

function toSelectValue(mailboxId: number | null): string {
  return mailboxId === null ? RECEIVING_INBOX : String(mailboxId);
}

function EditorField(props: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={props.htmlFor} className="text-sm font-medium text-foreground">
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

function PreviewRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words">{props.children}</dd>
    </div>
  );
}
