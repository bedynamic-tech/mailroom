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
import { cn } from "@/lib/utils";
import {
  describeMailRuleConditions,
  isConditionGroup,
  MAIL_RULE_FIELD_LABELS,
  MAIL_RULE_OPERATOR_LABELS,
  MAIL_RULE_OPERATORS,
  MAX_MAIL_RULE_NAME_LENGTH,
  MAX_MAIL_RULE_TEXT_LENGTH,
  operatorTakesValue,
} from "../../shared/mail-rules";
import { splitAddressInput } from "../../shared/recipients";
import type {
  MailRule,
  MailRuleCondition,
  MailRuleConditionGroup,
  MailRuleConditions,
  MailRuleField,
  MailRuleInput,
  MailRuleMatch,
  MailRuleOperator,
} from "../../shared/types";
import { deleteMailRule, fetchLabels, fetchMailboxes, fetchMailRules, saveMailRule } from "../api";
import { formatTime } from "../lib";
import { PencilIcon, PlusIcon, TrashIcon, XIcon } from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

const ALL_INBOXES = "all";
const NO_LABEL = "none";

const newCondition = (): MailRuleCondition => ({ field: "from", operator: "contains", value: "" });

const EMPTY_RULE: MailRuleInput = {
  mailbox_id: null,
  name: "",
  enabled: true,
  conditions: { match: "all", items: [newCondition()] },
  label_id: null,
  mark_read: false,
  archive: false,
  skip_draft: false,
  skip_notifications: false,
  forward_to: [],
  forward_cc: [],
  forward_bcc: [],
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
  const listError = toggle.error ?? remove.error;

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
          description="Rules check every new inbound email. When a rule’s conditions match, its actions run before the agent drafts or anyone is notified."
          action={
            <Button size="sm" onClick={() => setEditing("new")}>
              <PlusIcon className="h-4 w-4" />
              New rule
            </Button>
          }
        >
          <SettingsPanel>
            {listError && (
              <p className="border-b px-4 py-2 text-xs text-destructive sm:px-5" role="alert">
                {listError instanceof Error ? listError.message : "Couldn’t update this rule"}
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
                      <p className="mt-0.5 text-xs leading-5 break-words text-muted-foreground">
                        <span className="font-medium text-foreground/80">If</span>{" "}
                        {describeMailRuleConditions(rule.conditions)}{" "}
                        <span className="font-medium text-foreground/80">then</span> {describeActions(rule)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        On {rule.mailbox_address ?? "all inboxes"}
                        {" · "}
                        {rule.match_count === 0
                          ? "No matches yet"
                          : `${rule.match_count.toLocaleString()} ${rule.match_count === 1 ? "match" : "matches"}`}
                        {rule.last_matched_at && `, last ${formatTime(rule.last_matched_at)}`}
                        {rule.forward_count > 0 && ` · ${rule.forward_count.toLocaleString()} forwarded`}
                      </p>
                      {rule.last_forward_error && (
                        <p className="mt-0.5 text-xs text-destructive">
                          Last forward failed: {rule.last_forward_error}
                        </p>
                      )}
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
                No rules yet. For example: if From is at vendor.com and Has attachment is yes,
                apply the Invoices label and forward it to accounting.
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

function describeActions(rule: MailRule): string {
  const parts: string[] = [];
  if (rule.label_id !== null) parts.push(`label “${rule.label_name ?? "deleted label"}”`);
  if (rule.mark_read) parts.push("mark as read");
  if (rule.archive) parts.push("archive");
  if (rule.skip_draft) parts.push("don’t draft a reply");
  if (rule.skip_notifications) parts.push("don’t notify");
  if (rule.forward_to.length) {
    const extra = [
      rule.forward_cc.length ? `cc ${rule.forward_cc.join(", ")}` : "",
      rule.forward_bcc.length ? `bcc ${rule.forward_bcc.join(", ")}` : "",
    ].filter(Boolean);
    parts.push(`forward to ${rule.forward_to.join(", ")}${extra.length ? ` (${extra.join("; ")})` : ""}`);
  }
  return parts.length ? parts.join(", ") : "do nothing (its label was deleted)";
}

function MailRuleDialog(props: {
  rule: MailRule | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<MailRuleInput>(EMPTY_RULE);
  const [forwarding, setForwarding] = useState(false);
  const [forward, setForward] = useState({ to: "", cc: "", bcc: "" });
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes });
  const labels = useQuery({
    queryKey: ["labels", draft.mailbox_id],
    queryFn: () => fetchLabels(draft.mailbox_id),
    enabled: draft.mailbox_id !== null,
  });
  const save = useMutation({
    mutationFn: () =>
      saveMailRule({
        ...draft,
        forward_to: forwarding ? splitAddressInput(forward.to) : [],
        forward_cc: forwarding ? splitAddressInput(forward.cc) : [],
        forward_bcc: forwarding ? splitAddressInput(forward.bcc) : [],
        id: props.rule && props.rule !== "new" ? props.rule.id : undefined,
      }),
    onSuccess: props.onSaved,
  });
  const { reset } = save;

  useEffect(() => {
    if (!props.rule) return;
    reset();
    const input = props.rule === "new" ? EMPTY_RULE : toInput(props.rule);
    setDraft(input);
    setForwarding(input.forward_to.length > 0);
    setForward({
      to: input.forward_to.join(", "),
      cc: input.forward_cc.join(", "),
      bcc: input.forward_bcc.join(", "),
    });
  }, [props.rule, reset]);

  const update = (patch: Partial<MailRuleInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (save.isError) save.reset();
  };
  const updateForward = (patch: Partial<typeof forward>) => {
    setForward((current) => ({ ...current, ...patch }));
    if (save.isError) save.reset();
  };

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
      <DialogContent fullScreenOnMobile showCloseButton={!save.isPending} className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="min-w-0 space-y-6">
          <DialogHeader>
            <DialogTitle>{props.rule === "new" ? "New rule" : "Edit rule"}</DialogTitle>
            <DialogDescription>
              Text matching ignores case. Click AND or OR to switch how conditions combine.
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

          <section aria-label="Conditions" className="space-y-2">
            <ConditionFlow
              conditions={draft.conditions}
              onChange={(conditions) => update({ conditions })}
            />
          </section>

          <section aria-label="Actions" className="space-y-3">
            <StepLabel>Then</StepLabel>
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
                <SelectTrigger id="rule-label" className="w-full sm:w-72">
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
            <div className="grid gap-2.5 sm:grid-cols-2">
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
                label="Don’t send notifications"
                checked={draft.skip_notifications}
                onChange={(skip_notifications) => update({ skip_notifications })}
              />
            </div>
            <div className="space-y-3 rounded-lg border px-3 py-3">
              <CheckboxRow
                id="rule-forward"
                label="Forward it"
                checked={forwarding}
                onChange={(checked) => {
                  setForwarding(checked);
                  if (save.isError) save.reset();
                }}
              />
              {forwarding && (
                <div className="space-y-2.5">
                  {(["to", "cc", "bcc"] as const).map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <label
                        htmlFor={`rule-forward-${key}`}
                        className="w-9 shrink-0 text-sm text-muted-foreground"
                      >
                        {key === "to" ? "To" : key === "cc" ? "Cc" : "Bcc"}
                      </label>
                      <Input
                        id={`rule-forward-${key}`}
                        value={forward[key]}
                        onChange={(event) => updateForward({ [key]: event.target.value })}
                        placeholder={key === "to" ? "accounting@example.com" : "Optional"}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  ))}
                  <p className="text-xs leading-5 text-muted-foreground">
                    Separate addresses with commas. The forward is sent from the inbox that
                    received the email, with replies going to the original sender.
                  </p>
                </div>
              )}
            </div>
          </section>

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

/**
 * The rule's conditions as a flow: IF, then each condition or group joined by
 * the AND/OR of its list. The connector toggles the whole list, so a flow
 * never mixes AND and OR at one level; groups carry the other one.
 */
function ConditionFlow(props: {
  conditions: MailRuleConditions;
  onChange: (conditions: MailRuleConditions) => void;
}) {
  const { match, items } = props.conditions;
  const setItems = (next: MailRuleConditions["items"]) => props.onChange({ match, items: next });
  const replace = (index: number, item: MailRuleCondition | MailRuleConditionGroup) =>
    setItems(items.map((current, i) => (i === index ? item : current)));
  const removeAt = (index: number) => setItems(items.filter((_, i) => i !== index));

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="space-y-2">
          <StepLabel>
            {index === 0 ? (
              "If"
            ) : (
              <Connector
                match={match}
                onToggle={() => props.onChange({ match: flip(match), items })}
              />
            )}
          </StepLabel>
          {isConditionGroup(item) ? (
            <ConditionGroupEditor
              group={item}
              onChange={(group) =>
                group.conditions.length === 0 ? removeAt(index) : replace(index, group)
              }
              onRemove={() => removeAt(index)}
            />
          ) : (
            <ConditionRow
              condition={item}
              onChange={(condition) => replace(index, condition)}
              onRemove={items.length > 1 ? () => removeAt(index) : undefined}
            />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={() => setItems([...items, newCondition()])}>
          <PlusIcon className="h-4 w-4" />
          Add condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setItems([...items, { match: flip(match), conditions: [newCondition(), newCondition()] }])
          }
        >
          <PlusIcon className="h-4 w-4" />
          Add {flip(match) === "any" ? "OR" : "AND"} group
        </Button>
      </div>
    </div>
  );
}

function ConditionGroupEditor(props: {
  group: MailRuleConditionGroup;
  onChange: (group: MailRuleConditionGroup) => void;
  onRemove: () => void;
}) {
  const { match, conditions } = props.group;
  const setConditions = (next: MailRuleCondition[]) => props.onChange({ match, conditions: next });

  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-2.5 sm:p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Group: {match === "all" ? "all of these" : "any of these"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={props.onRemove}
          aria-label="Remove group"
          className="text-muted-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      {conditions.map((condition, index) => (
        <div key={index} className="space-y-2">
          {index > 0 && (
            <StepLabel>
              <Connector
                match={match}
                onToggle={() => props.onChange({ match: flip(match), conditions })}
              />
            </StepLabel>
          )}
          <ConditionRow
            condition={condition}
            onChange={(next) => setConditions(conditions.map((current, i) => (i === index ? next : current)))}
            onRemove={() => setConditions(conditions.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setConditions([...conditions, newCondition()])}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add to group
      </Button>
    </div>
  );
}

function ConditionRow(props: {
  condition: MailRuleCondition;
  onChange: (condition: MailRuleCondition) => void;
  onRemove?: () => void;
}) {
  const { field, operator, value } = props.condition;
  const operators = MAIL_RULE_OPERATORS[field];
  const takesValue = operatorTakesValue(operator);

  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "grid min-w-0 flex-1 grid-cols-2 gap-2",
          takesValue && "sm:grid-cols-[9.5rem_10.5rem_minmax(0,1fr)]",
        )}
      >
        <Select
          value={field}
          onValueChange={(next) => {
            const nextField = next as MailRuleField;
            const allowed = MAIL_RULE_OPERATORS[nextField];
            const nextOperator = allowed.includes(operator) ? operator : allowed[0]!;
            props.onChange({
              field: nextField,
              operator: nextOperator,
              value: operatorTakesValue(nextOperator) ? value : "",
            });
          }}
        >
          <SelectTrigger className="w-full" aria-label="Field">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MAIL_RULE_OPERATORS) as MailRuleField[]).map((option) => (
              <SelectItem key={option} value={option}>
                {MAIL_RULE_FIELD_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={operator}
          onValueChange={(next) =>
            props.onChange({
              field,
              operator: next as MailRuleOperator,
              value: operatorTakesValue(next as MailRuleOperator) ? value : "",
            })
          }
        >
          <SelectTrigger className="w-full" aria-label="Comparison">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {operators.map((option) => (
              <SelectItem key={option} value={option}>
                {MAIL_RULE_OPERATOR_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {takesValue && (
          <Input
            className="col-span-2 sm:col-span-1"
            value={value}
            maxLength={MAX_MAIL_RULE_TEXT_LENGTH}
            onChange={(event) => props.onChange({ field, operator, value: event.target.value })}
            placeholder={placeholderFor(field, operator)}
            aria-label="Value"
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>
      {props.onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={props.onRemove}
          aria-label="Remove condition"
          className="shrink-0 text-muted-foreground"
        >
          <XIcon className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function placeholderFor(field: MailRuleField, operator: MailRuleOperator): string {
  if (operator === "domain_is") return "example.com";
  if (field === "from" || field === "to" || field === "cc") {
    return operator === "is" || operator === "is_not" ? "name@example.com" : "Name or address";
  }
  if (field === "attachment_name") return operator === "ends_with" ? ".pdf" : "invoice";
  if (field === "subject") return "Invoice";
  return "Text";
}

function Connector(props: { match: MailRuleMatch; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      title={`Switch to ${props.match === "all" ? "OR" : "AND"}`}
      className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-semibold tracking-wide text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {props.match === "all" ? "AND" : "OR"}
    </button>
  );
}

function StepLabel(props: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {props.children}
    </div>
  );
}

const flip = (match: MailRuleMatch): MailRuleMatch => (match === "all" ? "any" : "all");

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
