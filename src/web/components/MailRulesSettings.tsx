import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import {
  MAX_MAIL_RULE_NAME_LENGTH,
  MAX_MAIL_RULE_TEXT_LENGTH,
} from "../../shared/mail-rules";
import type { MailRule, MailRuleInput } from "../../shared/types";
import { deleteMailRule, fetchLabels, fetchMailboxes, fetchMailRules, saveMailRule } from "../api";
import { formatTime } from "../lib";
import { PencilIcon, PlusIcon, TrashIcon } from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

const ALL_INBOXES = "all";
const NO_LABEL = "none";

const EMPTY_RULE: MailRuleInput = {
  mailbox_id: null,
  name: "",
  enabled: true,
  from_pattern: null,
  subject_contains: null,
  body_contains: null,
  has_attachment: false,
  label_id: null,
  mark_read: false,
  archive: false,
  skip_draft: false,
  skip_notifications: false,
};

function toInput(rule: MailRule): MailRuleInput {
  const input = { ...EMPTY_RULE };
  for (const key of Object.keys(EMPTY_RULE) as Array<keyof MailRuleInput>) {
    (input as Record<string, unknown>)[key] = rule[key];
  }
  return input;
}

export function MailRulesSettings(props: {
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
  onOpenContacts: () => void;
  onOpenSpam: () => void;
  onOpenAi: () => void;
}) {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ["mail-rules"], queryFn: fetchMailRules });
  const [editing, setEditing] = useState<MailRule | "new" | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["mail-rules"] });
  const toggle = useMutation({
    mutationFn: (rule: MailRule) => saveMailRule({ ...toInput(rule), enabled: !rule.enabled, id: rule.id }),
    onSettled: invalidate,
  });
  const remove = useMutation({ mutationFn: deleteMailRule, onSettled: invalidate });

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="rules"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenInboxes={props.onOpenInboxes}
        onOpenContacts={props.onOpenContacts}
        onOpenRules={() => undefined}
        onOpenSpam={props.onOpenSpam}
        onOpenAi={props.onOpenAi}
      />

      <SettingsPage>
        <SettingsBlock
          id="mail-rules-heading"
          title="Rules"
          description="Rules check every new inbound email. When all of a rule’s conditions match, its actions run before the agent drafts or anyone is notified."
          action={
            <Button size="sm" onClick={() => setEditing("new")}>
              <PlusIcon className="h-4 w-4" />
              New rule
            </Button>
          }
        >
          <SettingsPanel>
            {(toggle.isError || remove.isError) && (
              <p className="border-b px-4 py-2 text-xs text-destructive sm:px-5" role="alert">
                {(toggle.error ?? remove.error) instanceof Error
                  ? (toggle.error ?? remove.error)!.message
                  : "Couldn’t update this rule"}
              </p>
            )}
            {rules.isLoading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">Loading…</p>
            ) : rules.isError ? (
              <p className="px-4 py-6 text-sm text-destructive sm:px-5" role="alert">
                Couldn’t load rules.
              </p>
            ) : rules.data?.length ? (
              <ul className="divide-y">
                {rules.data.map((rule) => (
                  <li key={rule.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                    <Switch
                      className="mt-0.5"
                      checked={rule.enabled}
                      disabled={toggle.isPending && toggle.variables?.id === rule.id}
                      onCheckedChange={() => toggle.mutate(rule)}
                      aria-label={`${rule.enabled ? "Turn off" : "Turn on"} ${rule.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{rule.name}</p>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        <span className="text-foreground/80">When</span> {describeConditions(rule)}
                        {" "}
                        <span className="text-foreground/80">then</span> {describeActions(rule)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        On {rule.mailbox_address ?? "all inboxes"}
                        {" · "}
                        {rule.match_count === 0
                          ? "No matches yet"
                          : `${rule.match_count.toLocaleString()} ${rule.match_count === 1 ? "match" : "matches"}`}
                        {rule.last_matched_at && `, last ${formatTime(rule.last_matched_at)}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(rule)}
                      aria-label={`Edit ${rule.name}`}
                      className="shrink-0 text-muted-foreground"
                    >
                      <PencilIcon className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (window.confirm(`Delete the rule “${rule.name}”?`)) remove.mutate(rule.id);
                      }}
                      disabled={remove.isPending && remove.variables === rule.id}
                      aria-label={`Delete ${rule.name}`}
                      className="shrink-0 text-muted-foreground"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
                No rules yet. For example: when mail is from billing@vendor.com and has an
                attachment, apply the Invoices label and archive it.
              </p>
            )}
          </SettingsPanel>
        </SettingsBlock>
      </SettingsPage>

      <MailRuleDialog
        rule={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
      />
    </div>
  );
}

function describeConditions(rule: MailRule): string {
  const parts: string[] = [];
  if (rule.from_pattern) parts.push(`from matches “${rule.from_pattern}”`);
  if (rule.subject_contains) parts.push(`subject contains “${rule.subject_contains}”`);
  if (rule.body_contains) parts.push(`body contains “${rule.body_contains}”`);
  if (rule.has_attachment) parts.push("it has an attachment");
  return parts.join(" and ");
}

function describeActions(rule: MailRule): string {
  const parts: string[] = [];
  if (rule.label_id !== null) parts.push(`label “${rule.label_name ?? "deleted label"}”`);
  if (rule.mark_read) parts.push("mark as read");
  if (rule.archive) parts.push("archive");
  if (rule.skip_draft) parts.push("don’t draft a reply");
  if (rule.skip_notifications) parts.push("don’t notify");
  return parts.length ? parts.join(", ") : "do nothing (its label was deleted)";
}

function MailRuleDialog(props: {
  rule: MailRule | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<MailRuleInput>(EMPTY_RULE);
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes });
  const labels = useQuery({
    queryKey: ["labels", draft.mailbox_id],
    queryFn: () => fetchLabels(draft.mailbox_id),
    enabled: draft.mailbox_id !== null,
  });
  const save = useMutation({
    mutationFn: () =>
      saveMailRule({ ...draft, id: props.rule && props.rule !== "new" ? props.rule.id : undefined }),
    onSuccess: props.onSaved,
  });
  const { reset } = save;

  useEffect(() => {
    if (!props.rule) return;
    reset();
    setDraft(props.rule === "new" ? EMPTY_RULE : toInput(props.rule));
  }, [props.rule, reset]);

  const update = (patch: Partial<MailRuleInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (save.isError) save.reset();
  };
  const text = (value: string) => (value === "" ? null : value);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open={props.rule !== null}
      onOpenChange={(open) => {
        if (!open && !save.isPending) props.onClose();
      }}
    >
      <DialogContent showCloseButton={!save.isPending} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{props.rule === "new" ? "New rule" : "Edit rule"}</DialogTitle>
            <DialogDescription>
              Every condition you fill in must match. Text matching ignores case.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="rule-name">
              <Input
                id="rule-name"
                value={draft.name}
                maxLength={MAX_MAIL_RULE_NAME_LENGTH}
                onChange={(event) => update({ name: event.target.value })}
                placeholder="Vendor invoices"
                autoComplete="off"
              />
            </Field>
            <Field label="Applies to" htmlFor="rule-inbox">
              <Select
                value={draft.mailbox_id === null ? ALL_INBOXES : String(draft.mailbox_id)}
                onValueChange={(value) =>
                  update({ mailbox_id: value === ALL_INBOXES ? null : Number(value), label_id: null })
                }
              >
                <SelectTrigger id="rule-inbox" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_INBOXES}>All inboxes</SelectItem>
                  {(mailboxes.data ?? []).map((mailbox) => (
                    <SelectItem key={mailbox.id} value={String(mailbox.id)}>
                      {mailbox.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <fieldset className="space-y-3">
            <legend className="mb-2 text-xs font-medium text-muted-foreground">When</legend>
            <Field label="From" htmlFor="rule-from" hint="An address, a domain such as vendor.com, or part of the sender’s name">
              <Input
                id="rule-from"
                value={draft.from_pattern ?? ""}
                maxLength={MAX_MAIL_RULE_TEXT_LENGTH}
                onChange={(event) => update({ from_pattern: text(event.target.value) })}
                placeholder="billing@vendor.com"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label="Subject contains" htmlFor="rule-subject">
              <Input
                id="rule-subject"
                value={draft.subject_contains ?? ""}
                maxLength={MAX_MAIL_RULE_TEXT_LENGTH}
                onChange={(event) => update({ subject_contains: text(event.target.value) })}
                placeholder="Invoice"
                autoComplete="off"
              />
            </Field>
            <Field label="Body contains" htmlFor="rule-body">
              <Input
                id="rule-body"
                value={draft.body_contains ?? ""}
                maxLength={MAX_MAIL_RULE_TEXT_LENGTH}
                onChange={(event) => update({ body_contains: text(event.target.value) })}
                autoComplete="off"
              />
            </Field>
            <CheckboxRow
              id="rule-has-attachment"
              label="Has an attachment"
              checked={draft.has_attachment}
              onChange={(has_attachment) => update({ has_attachment })}
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-2 text-xs font-medium text-muted-foreground">Then</legend>
            <Field
              label="Apply label"
              htmlFor="rule-label"
              hint={draft.mailbox_id === null ? "Labels belong to one inbox. Choose an inbox above to apply one." : undefined}
            >
              <Select
                value={draft.label_id === null ? NO_LABEL : String(draft.label_id)}
                onValueChange={(value) => update({ label_id: value === NO_LABEL ? null : Number(value) })}
                disabled={draft.mailbox_id === null}
              >
                <SelectTrigger id="rule-label" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LABEL}>No label</SelectItem>
                  {(labels.data ?? []).map((label) => (
                    <SelectItem key={label.id} value={String(label.id)}>
                      {label.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <CheckboxRow
              id="rule-mark-read"
              label="Mark as read"
              checked={draft.mark_read}
              onChange={(mark_read) => update({ mark_read })}
            />
            <CheckboxRow
              id="rule-archive"
              label="Archive"
              checked={draft.archive}
              onChange={(archive) => update({ archive })}
            />
            <CheckboxRow
              id="rule-skip-draft"
              label="Don’t draft an AI reply"
              checked={draft.skip_draft}
              onChange={(skip_draft) => update({ skip_draft })}
            />
            <CheckboxRow
              id="rule-skip-notifications"
              label="Don’t send browser or email notifications"
              checked={draft.skip_notifications}
              onChange={(skip_notifications) => update({ skip_notifications })}
            />
          </fieldset>

          {save.isError && (
            <p className="text-sm text-destructive" role="alert">
              {save.error instanceof Error ? save.error.message : "Couldn’t save this rule"}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !draft.name.trim()}>
              {save.isPending ? "Saving…" : "Save rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={props.htmlFor} className="block text-sm font-medium text-foreground">
        {props.label}
      </label>
      {props.children}
      {props.hint && <p className="text-xs leading-5 text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

function CheckboxRow(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Checkbox
        id={props.id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(checked === true)}
      />
      <label htmlFor={props.id} className="text-sm text-foreground">
        {props.label}
      </label>
    </div>
  );
}
