import type { SignatureMode } from "./signature.ts";

export interface Mailbox {
  id: number;
  address: string;
  display_name: string | null;
  color: string;
  agent_mode: "off" | "draft" | "auto";
  agent_instructions: string | null;
  /** Whether the Inbox signs with the workspace default, its own signature, or none. */
  signature_mode: SignatureMode;
  /** The Inbox's own signature (sanitized HTML), used when signature_mode is "custom". */
  signature_html: string | null;
  /** The signature this Inbox currently appends to outgoing email, if any. */
  effective_signature_html: string | null;
  unread_count: number;
  domain_id: number | null;
  /** Whether this Inbox receives mail for addresses on its Domain that have no Inbox. */
  is_catch_all: boolean;
}

export interface Domain {
  id: number;
  name: string;
  status: "pending" | "active";
  inbox_count: number;
  /** The Inbox receiving mail for unregistered addresses on this Domain, if any. */
  catch_all_mailbox_id: number | null;
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
  /** Signature (sanitized HTML) for every Inbox set to use the default. */
  default_signature_html: string | null;
  /** Browser Notifications, while on, carry new email. */
  browser_new_email: boolean;
  /** Email Notifications, while on, carry new email. */
  email_new_email: boolean;
  /** Browser Notifications, while on, carry replies in existing Conversations. */
  browser_replies: boolean;
  /** Email Notifications, while on, carry replies in existing Conversations. */
  email_replies: boolean;
  /** Browser Notifications, while on, also carry Board Reminders. */
  browser_board_reminders: boolean;
  /** Email Notifications, while on, also carry Board Reminders. */
  email_board_reminders: boolean;
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
  /** The address a catch-all Conversation was sent to; null when it reached the Inbox's own address. */
  catch_all_recipient: string | null;
  /** Recipients edited in the reply box, as JSON (see shared/reply-recipients.ts); null when unedited. */
  reply_recipients: string | null;
  labels: ThreadLabel[];
  /** How many Board Cards link this Conversation. */
  board_card_count: number;
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
  /** Recipients of an outbound Message that a returned bounce notice reported as failed. */
  bounces: MessageBounce[];
}

export interface MessageBounce {
  message_id: number;
  recipient: string;
  status: string | null;
  diagnostic: string;
  created_at: string;
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
  board_cards: ThreadBoardCard[];
  /** Board Cards linking other Conversations from this Conversation's latest sender. */
  suggested_board_cards: ThreadBoardCard[];
  /** Internal Notes on this Conversation, oldest first. Never sent to anyone. */
  notes: ThreadNote[];
}

/** An Internal Note: rich text left on a Conversation for the team only. */
export interface ThreadNote {
  id: number;
  thread_id: number;
  text_body: string;
  html_body: string | null;
  /** The Mail Rule that added the note; null when a person wrote it. */
  mail_rule_id: number | null;
  /** That rule's current name, or null once it is deleted. */
  mail_rule_name: string | null;
  created_at: string;
}

/** A Board Card linked to a Conversation, as shown on that Conversation. */
export interface ThreadBoardCard {
  id: number;
  title: string;
  column_id: number;
  column_name: string;
}

export interface BoardColumn {
  id: number;
  name: string;
  position: number;
}

export interface BoardCardConversation {
  id: number;
  subject: string;
  status: ThreadSummary["status"];
  mailbox_address: string;
}

/** A Conversation suggested for a Board Card because it shares a sender with one it links. */
export interface RelatedConversation extends BoardCardConversation {
  last_from: string | null;
  last_message_at: string;
}

export interface BoardCard {
  id: number;
  column_id: number;
  title: string;
  description: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  note_count: number;
  /** When the Item should be done (UTC ISO), or null. */
  due_at: string | null;
  /** IANA time zone the due time was picked in. */
  due_time_zone: string | null;
  /** Minutes before due_at to remind (0 = at the due time); null means no reminder. */
  reminder_minutes: number | null;
  /** When the reminder went out; null while it is still to come. */
  reminder_sent_at: string | null;
  conversations: BoardCardConversation[];
}

export interface BoardCardNote {
  id: number;
  card_id: number;
  body: string;
  created_at: string;
}

/** A Board Card with its Notes, as shown when it is opened. */
export interface BoardCardDetail extends BoardCard {
  notes: BoardCardNote[];
}

export interface Board {
  columns: BoardColumn[];
  cards: BoardCard[];
}

export interface BoardCardInput {
  column_id?: number;
  title?: string;
  description?: string | null;
  thread_ids?: number[];
  /** Send with reminder_minutes and due_time_zone; null clears the due time. */
  due_at?: string | null;
  due_time_zone?: string | null;
  reminder_minutes?: number | null;
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
  /** Every email address of the Contact, primary first. */
  addresses: string[];
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

/** An address the catch-all has received mail for. */
export interface CatchAllAddress {
  address: string;
  conversation_count: number;
  unread_count: number;
  last_message_at: string;
  /** The Blocked Address rule for it, if it is blocked. */
  blocked_id: number | null;
}

/** An address on one of the workspace's Domains whose mail the catch-all rejects. */
export interface BlockedRecipient {
  id: number;
  address: string;
  blocked_count: number;
  last_blocked_at: string | null;
  created_at: string;
}

export interface BlockRecipientResult {
  blocked: BlockedRecipient;
  /** Caught Conversations for the address that were archived. */
  archived: number;
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
  /**
   * Create a Board Card in this Column, titled from the subject and linked to
   * the Conversation, unless the Conversation is already on the Board.
   */
  board_column_id: number | null;
  /** Add this plain text as an Internal Note on the Conversation; null for none. */
  note: string | null;
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
  board_column_name: string | null;
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

/** One Conversation found by the universal search. */
export interface SearchConversationResult {
  id: number;
  subject: string;
  status: ThreadSummary["status"];
  mailbox_address: string;
  /** The latest sender's name or address. */
  from: string | null;
  /** Text around the first match, or the Conversation's snippet. */
  excerpt: string;
  last_message_at: string;
}

/** One Internal Note found by the universal search. */
export interface SearchNoteResult {
  id: number;
  thread_id: number;
  thread_subject: string;
  thread_status: ThreadSummary["status"];
  mail_rule_name: string | null;
  excerpt: string;
  created_at: string;
}

/** One Board Item found by its title, description or one of its notes. */
export interface SearchBoardItemResult {
  id: number;
  title: string;
  column_name: string;
  /** Text around the match in the description or a note, or empty when only the title matched. */
  excerpt: string;
  matched_note: boolean;
}

export interface SearchRuleResult {
  id: number;
  name: string;
  enabled: boolean;
  mailbox_address: string | null;
  excerpt: string;
}

export interface SearchContactResult {
  id: number;
  address: string;
  name: string | null;
  company: string | null;
}

/** Everything the universal search found, grouped by kind. */
export interface UniversalSearchResults {
  conversations: SearchConversationResult[];
  notes: SearchNoteResult[];
  board_items: SearchBoardItemResult[];
  rules: SearchRuleResult[];
  contacts: SearchContactResult[];
}
