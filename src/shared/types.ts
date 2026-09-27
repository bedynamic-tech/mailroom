export interface Mailbox {
  id: number;
  address: string;
  display_name: string | null;
  color: string;
  agent_mode: "off" | "draft" | "auto";
  agent_instructions: string | null;
  unread_count: number;
}

export interface Domain {
  id: number;
  name: string;
  status: "pending" | "active";
  inbox_count: number;
  created_at: string;
  activated_at: string | null;
}

export interface GeneralSettings {
  browser_notifications_enabled: boolean;
  browser_notifications_configured: boolean;
  push_subscription_count: number;
  vapid_public_key: string | null;
  email_notifications_enabled: boolean;
  email_notification_address: string | null;
  email_notification_template: EmailNotificationTemplate;
  /** Create a Contact for each new inbound sender whose name can be parsed. */
  auto_create_contacts: boolean;
}

export interface EmailNotificationTemplate {
  from_name: string;
  /** Inbox to send from; null sends from the Inbox that received the email. */
  from_mailbox_id: number | null;
  subject: string;
  body: string;
}

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface Playbook {
  id: number;
  mailbox_id: number;
  name: string;
  when_to_use: string;
  instructions: string;
  example_reply: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PlaybookInput {
  mailbox_id: number;
  name: string;
  when_to_use: string;
  instructions: string;
  example_reply?: string | null;
  enabled?: boolean;
}

export interface Label {
  id: number;
  mailbox_id: number;
  name: string;
  condition: string;
  created_at: string;
  updated_at: string;
}

export interface LabelInput {
  mailbox_id: number;
  name: string;
  condition: string;
}

export interface ThreadLabel {
  id: number;
  name: string;
}

export interface ThreadSummary {
  id: number;
  mailbox_id: number;
  mailbox_address: string;
  mailbox_color: string;
  mailbox_agent_mode: Mailbox["agent_mode"];
  subject: string;
  snippet: string;
  status: "open" | "archived" | "needs_human";
  is_read: number;
  message_count: number;
  pending_draft_count: number;
  draft_run_status: DraftRunStatus | null;
  draft_run_error: string | null;
  latest_inbound_is_auto_submitted: number;
  last_message_direction: "inbound" | "outbound";
  last_message_at: string;
  last_from: string | null;
  last_from_address: string | null;
  labels: ThreadLabel[];
}

export interface Attachment {
  id: number;
  message_id: number;
  filename: string | null;
  content_type: string;
  size: number;
  disposition: "attachment" | "inline" | null;
  content_id: string | null;
}

export interface Message {
  id: number;
  thread_id: number;
  direction: "inbound" | "outbound";
  sent_by: "external" | "human" | "agent";
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  cc_addresses: string;
  /** Only populated for outbound Messages sent from Mailroom. */
  bcc_addresses: string;
  reply_to_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  is_auto_submitted: number;
  created_at: string;
  attachments: Attachment[];
}

export interface Draft {
  id: number;
  thread_id: number;
  text_body: string;
  created_by: "human" | "agent";
  agent_notes: string | null;
  playbook_id: number | null;
  playbook_name: string | null;
  status: "pending" | "sent" | "discarded";
  created_at: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
  drafts: Draft[];
  draft_run: DraftRun | null;
}

export type DraftRunStatus = "queued" | "generating" | "ready" | "failed" | "superseded";

export interface DraftRun {
  id: number;
  thread_id: number;
  inbound_message_id: number;
  status: DraftRunStatus;
  attempt_count: number;
  draft_id: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type ReplyAttemptStatus = "pending" | "sending" | "sent" | "failed";

export interface ReplyAttemptResult {
  ok: boolean;
  attempt_id: string;
  status: ReplyAttemptStatus;
  message_id: string | null;
  error?: string;
}

export interface ComposeAttemptResult extends ReplyAttemptResult {
  conversation_id: number | null;
}

export interface Contact {
  id: number;
  address: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  notes: string | null;
  /** When mail from this address last arrived; null for Contacts added by hand. */
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactInput {
  address: string;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface ContactConversation {
  id: number;
  mailbox_id: number;
  mailbox_address: string;
  subject: string;
  status: ThreadSummary["status"];
  last_message_at: string;
}

export interface ContactDetail {
  contact: Contact;
  conversation_count: number;
  conversations: ContactConversation[];
}

export interface ContactImportResult {
  created: number;
  /** Existing Contacts the import matched by address. */
  updated: number;
  skipped: number;
  /** The first few skipped entries and why. */
  errors: Array<{ address: string; error: string }>;
}

export interface BlockedSender {
  id: number;
  /** The Inbox this rule applies to, or null for all Inboxes. */
  mailbox_id: number | null;
  mailbox_address: string | null;
  /** An exact sender address, or a domain that also covers its subdomains. */
  kind: "address" | "domain";
  pattern: string;
  /** How many inbound emails this rule has rejected. */
  blocked_count: number;
  last_blocked_at: string | null;
  created_at: string;
}

export interface BlockSenderResult {
  /** The rule now blocking the sender. */
  blocked: BlockedSender;
  /** Conversations archived, including the one the sender was blocked from. */
  archived: number;
}

export type MailRuleField =
  | "from"
  | "to"
  | "cc"
  | "subject"
  | "body"
  | "attachment_name"
  | "has_attachment";

export type MailRuleOperator =
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "starts_with"
  | "ends_with"
  /** The address is at this domain or one of its subdomains. */
  | "domain_is"
  /** Has attachment: at least one, or none. Inline images do not count. */
  | "yes"
  | "no";

/** Whether every ("all") or at least one ("any") of a list of conditions must hold. */
export type MailRuleMatch = "all" | "any";

export interface MailRuleCondition {
  field: MailRuleField;
  operator: MailRuleOperator;
  /** Empty for operators that take no value. */
  value: string;
}

export interface MailRuleConditionGroup {
  match: MailRuleMatch;
  conditions: MailRuleCondition[];
}

/** What a Mail Rule looks for: conditions and one level of condition groups. */
export interface MailRuleConditions {
  match: MailRuleMatch;
  items: Array<MailRuleCondition | MailRuleConditionGroup>;
}

/** What a Mail Rule does to a matching inbound Message and its Conversation. */
export interface MailRuleActions {
  /** A Label of the rule's Inbox; only rules for one Inbox can apply a Label. */
  label_id: number | null;
  mark_read: boolean;
  archive: boolean;
  /** Never start a Draft Run for the Message. */
  skip_draft: boolean;
  /** Send no browser or email notification for the Message. */
  skip_notifications: boolean;
  /** Forward the Message from its Inbox; empty To means no forward. */
  forward_to: string[];
  forward_cc: string[];
  forward_bcc: string[];
}

export interface MailRuleInput extends MailRuleActions {
  /** The Inbox this rule applies to, or null for all Inboxes. */
  mailbox_id: number | null;
  name: string;
  enabled: boolean;
  conditions: MailRuleConditions;
}

export interface MailRule extends MailRuleInput {
  id: number;
  mailbox_address: string | null;
  label_name: string | null;
  /** How many inbound emails this rule has matched. */
  match_count: number;
  last_matched_at: string | null;
  /** Forwards this rule has sent. */
  forward_count: number;
  /** The provider error of this rule's latest forward, when that forward failed. */
  last_forward_error: string | null;
  created_at: string;
  updated_at: string;
}
