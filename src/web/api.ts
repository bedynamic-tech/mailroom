import type {
  Board,
  BoardCard,
  BoardCardDetail,
  BoardCardInput,
  BoardCardNote,
  BoardColumn,
  RelatedConversation,
  BlockedRecipient,
  BlockedSender,
  BlockRecipientResult,
  CatchAllAddress,
  BrowserPushSubscription,
  ComposeAttemptResult,
  Contact,
  ContactDetail,
  ContactImportResult,
  ContactInput,
  Domain,
  EmailNotificationTemplate,
  GeneralSettings,
  Label,
  LabelInput,
  Mailbox,
  MailRule,
  MailRuleInput,
  Playbook,
  PlaybookInput,
  ReplyAttemptResult,
  BlockSenderResult,
  ThreadSummary,
  ThreadDetail,
  ThreadNote,
  UniversalSearchResults,
} from "../shared/types";

export interface AccessHint {
  team_domain: string;
  aud: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly hint?: AccessHint,
    /** The existing record's id when a create conflicts with one (409). */
    readonly existingId?: number,
  ) {
    super(message);
  }
}

const ACCESS_SETUP_CODES = ["access_not_configured", "access_missing", "access_invalid"];

/** The API rejected the request because Cloudflare Access is not set up correctly. */
export function accessSetupError(error: unknown): ApiError | null {
  return error instanceof ApiError && error.code && ACCESS_SETUP_CODES.includes(error.code)
    ? error
    : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: { error?: string; code?: string; hint?: AccessHint; id?: number } = {};
    try {
      body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based fallback for non-JSON responses.
    }
    throw new ApiError(message, res.status, body.code, body.hint, body.id);
  }
  return res.json() as Promise<T>;
}

export const fetchMailboxes = () => request<Mailbox[]>("/mailboxes");

export class ComposeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function composeEmail(input: {
  mailboxId: number;
  to: string;
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  /** Rich-text body; the server derives the plain-text part from it. */
  html?: string;
  files: File[];
  attemptId: string;
}): Promise<ComposeAttemptResult> {
  const form = new FormData();
  form.set("mailbox_id", String(input.mailboxId));
  form.set("to", input.to);
  for (const address of input.cc) form.append("cc", address);
  for (const address of input.bcc) form.append("bcc", address);
  form.set("subject", input.subject);
  form.set("text", input.text);
  if (input.html) form.set("html", input.html);
  form.set("attempt_id", input.attemptId);
  for (const file of input.files) form.append("attachments", file, file.name);
  const response = await fetch("/api/compose", { method: "POST", body: form });
  const body = await response.json() as ComposeAttemptResult & { error?: string };
  // Provider failures are terminal send results, distinct from an uncertain
  // network/server failure where the same attempt must be checked again.
  if (["sent", "failed", "pending", "sending"].includes(body.status)) return body;
  throw new ComposeRequestError(body.error ?? `Could not send (${response.status})`, response.status);
}

export const fetchGeneralSettings = () =>
  request<GeneralSettings>("/settings/general");

export const enableBrowserNotifications = (subscription: BrowserPushSubscription) =>
  request<{ ok: true }>("/settings/browser-notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });

export const updateBoardReminders = (input: { browser?: boolean; email?: boolean }) =>
  request<{ ok: true }>("/settings/board-reminders", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const disableBrowserNotifications = () =>
  request<{ ok: true }>("/settings/browser-notifications", { method: "DELETE" });

export const updateEmailNotifications = (address: string) =>
  request<{ ok: true }>("/settings/email-notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

export const setEmailNotificationsEnabled = (enabled: boolean) =>
  request<{ ok: true }>("/settings/email-notifications/enabled", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

export const sendTestEmailNotification = () =>
  request<{ status: "sent"; from: string; to: string }>("/settings/email-notifications/test", {
    method: "POST",
  });

export const updateEmailNotificationTemplate = (template: EmailNotificationTemplate) =>
  request<{ ok: true }>("/settings/email-notification-template", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });

export const setAutoCreateContacts = (autoCreate: boolean) =>
  request<{ ok: true }>("/settings/contacts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auto_create: autoCreate }),
  });

export const updateDefaultSignature = (html: string | null) =>
  request<{ ok: true; html: string | null }>("/settings/default-signature", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html }),
  });

export const fetchDomains = () => request<Domain[]>("/domains");

export const createDomain = (input: { name: string }) =>
  request<Domain>("/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const activateDomain = (id: number) =>
  request<Domain>(`/domains/${id}/activate`, { method: "POST" });

export const createMailbox = (input: { local_part: string; domain_id: number }) =>
  request<Mailbox>("/mailboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateMailbox = (
  id: number,
  input: Partial<
    Pick<
      Mailbox,
      "agent_mode" | "agent_instructions" | "display_name" | "signature_mode" | "signature_html"
    >
  >,
) =>
  request<{ ok: true }>(`/mailboxes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteMailbox = (id: number, confirmAddress: string) =>
  request<{ ok: true; deleted_id: number; domain_id: number | null }>(`/mailboxes/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_address: confirmAddress }),
  });

export const fetchPlaybooks = (mailboxId: number) =>
  request<Playbook[]>(`/playbooks?mailbox_id=${mailboxId}`);

export const createPlaybook = (input: PlaybookInput) =>
  request<Playbook>("/playbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updatePlaybook = (id: number, input: Partial<PlaybookInput>) =>
  request<Playbook>(`/playbooks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deletePlaybook = (id: number) =>
  request<{ ok: true }>(`/playbooks/${id}`, { method: "DELETE" });

export const fetchLabels = (mailboxId?: number | null) =>
  request<Label[]>(`/labels${mailboxId ? `?mailbox_id=${mailboxId}` : ""}`);

export const createLabel = (input: LabelInput) =>
  request<Label>("/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateLabel = (id: number, input: Partial<LabelInput>) =>
  request<Label>(`/labels/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteLabel = (id: number) =>
  request<{ ok: true }>(`/labels/${id}`, { method: "DELETE" });

export const THREAD_PAGE_SIZE = 50;

export interface ThreadQuery {
  mailboxId: number | null;
  labelId: number | null;
  status: ThreadSummary["status"];
  unread: boolean;
}

export interface ThreadCursor {
  at: string;
  id: number;
}

function threadScopeParams(query: Omit<ThreadQuery, "status">) {
  const params = new URLSearchParams();
  if (query.mailboxId !== null) params.set("mailbox_id", String(query.mailboxId));
  if (query.labelId !== null) params.set("label_id", String(query.labelId));
  if (query.unread) params.set("unread", "1");
  return params;
}

export const fetchThreads = (query: ThreadQuery, cursor: ThreadCursor | null = null) => {
  const params = threadScopeParams(query);
  if (query.status !== "open") params.set("status", query.status);
  if (cursor) {
    params.set("before_at", cursor.at);
    params.set("before_id", String(cursor.id));
  }
  const search = params.toString();
  return request<ThreadSummary[]>(`/threads${search ? `?${search}` : ""}`);
};

export const fetchThread = (id: number) => request<ThreadDetail>(`/threads/${id}`);

export const searchThreads = (q: string, query: Omit<ThreadQuery, "status">) => {
  const params = threadScopeParams(query);
  params.set("q", q);
  return request<ThreadSummary[]>(`/search?${params}`);
};

/** Searches conversations, internal notes, board items, rules and contacts at once. */
export const searchEverything = (q: string) =>
  request<UniversalSearchResults>(`/search/all?${new URLSearchParams({ q })}`);

export type BulkThreadAction = "read" | "archive" | "unarchive" | "delete";

export const bulkUpdateThreads = (ids: number[], action: BulkThreadAction) =>
  request<{ ok: true; updated?: number; deleted_ids?: number[] }>("/threads/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });

export const markRead = (id: number) => request(`/threads/${id}/read`, { method: "POST" });

export const archiveThread = (id: number) => request(`/threads/${id}/archive`, { method: "POST" });

export const unarchiveThread = (id: number) =>
  request(`/threads/${id}/unarchive`, { method: "POST" });

export const deleteThread = (id: number) =>
  request<{ ok: true; deleted_ids: number[] }>(`/threads/${id}`, { method: "DELETE" });

export const emptyArchive = () =>
  request<{ ok: true; deleted: number; skipped: number }>("/archive/empty", { method: "POST" });

export const sendReply = (
  id: number,
  text: string,
  attemptId: string,
  draftId?: number,
  attachments: File[] = [],
  copies: { cc: string[]; bcc: string[] } = { cc: [], bcc: [] },
  html?: string,
) => {
  const form = new FormData();
  form.set("text", text);
  if (html) form.set("html", html);
  form.set("attempt_id", attemptId);
  for (const address of copies.cc) form.append("cc", address);
  for (const address of copies.bcc) form.append("bcc", address);
  if (draftId !== undefined) form.set("draft_id", String(draftId));
  for (const file of attachments) form.append("attachments", file, file.name);
  return request<ReplyAttemptResult>(`/threads/${id}/reply`, {
    method: "POST",
    body: form,
  });
};

export const discardDraft = (id: number) => request(`/drafts/${id}/discard`, { method: "POST" });

export const retryDraftRun = (id: number) =>
  request<{ ok: true }>(`/draft-runs/${id}/retry`, { method: "POST" });

export const createDraft = (threadId: number) =>
  request<{ ok: true; run_id: number }>(`/threads/${threadId}/draft`, { method: "POST" });

export const CONTACT_PAGE_SIZE = 100;

/** The last contact of a page of the A-Z contact list. */
export interface ContactCursor {
  address: string;
  name: string | null;
  id: number;
}

/** Most recently seen contacts first, for recipient suggestions. */
export const fetchContacts = (q: string, limit?: number) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (limit) params.set("limit", String(limit));
  const search = params.toString();
  return request<Contact[]>(`/contacts${search ? `?${search}` : ""}`);
};

/** Contacts sorted A-Z by name, or by address when unnamed. */
export const fetchContactsByName = (q: string, cursor: ContactCursor | null = null) => {
  const params = new URLSearchParams({ sort: "name" });
  if (q) params.set("q", q);
  if (cursor) {
    params.set("after_address", cursor.address);
    params.set("after_name", cursor.name ?? "");
    params.set("after_id", String(cursor.id));
  }
  const search = params.toString();
  return request<Contact[]>(`/contacts${search ? `?${search}` : ""}`);
};

export const fetchContact = (id: number) => request<ContactDetail>(`/contacts/${id}`);

export const createContact = (input: ContactInput) =>
  request<Contact>("/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateContact = (id: number, input: Omit<ContactInput, "address">) =>
  request<Contact>(`/contacts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteContact = (id: number) =>
  request<{ ok: true }>(`/contacts/${id}`, { method: "DELETE" });

export const importContacts = (contacts: ContactInput[], overwrite: boolean) =>
  request<ContactImportResult>("/contacts/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contacts, overwrite }),
  });

export const fetchBlockedSenders = () => request<BlockedSender[]>("/blocked-senders");

export const blockSender = (input: { pattern: string; mailboxId: number | null }) =>
  request<BlockedSender>("/blocked-senders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pattern: input.pattern, mailbox_id: input.mailboxId }),
  });

export const unblockSender = (id: number) =>
  request<{ ok: true }>(`/blocked-senders/${id}`, { method: "DELETE" });

export const blockThreadSender = (
  threadId: number,
  kind: "address" | "domain",
  scope: "inbox" | "all",
  address?: string,
) =>
  request<BlockSenderResult>(`/threads/${threadId}/block-sender`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, scope, address }),
  });

export const fetchMailRules = () => request<MailRule[]>("/mail-rules");

export const saveMailRule = (input: MailRuleInput & { id?: number }) => {
  const { id, ...rule } = input;
  return request<MailRule>(id ? `/mail-rules/${id}` : "/mail-rules", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rule),
  });
};

export const deleteMailRule = (id: number) =>
  request<{ ok: true }>(`/mail-rules/${id}`, { method: "DELETE" });

export const setDomainCatchAll = (domainId: number, mailboxId: number | null) =>
  request<{ ok: true }>(`/domains/${domainId}/catch-all`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mailbox_id: mailboxId }),
  });

export const fetchCatchAllAddresses = (mailboxId: number) =>
  request<CatchAllAddress[]>(`/mailboxes/${mailboxId}/catch-all/addresses`);

export const createInboxFromCatchAll = (input: { address: string; moveConversations: boolean }) =>
  request<{ mailbox: Mailbox; moved: number }>("/catch-all/inboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: input.address, move_conversations: input.moveConversations }),
  });

export const fetchBlockedRecipients = () => request<BlockedRecipient[]>("/blocked-recipients");

export const blockRecipient = (address: string) =>
  request<BlockRecipientResult>("/blocked-recipients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

export const unblockRecipient = (id: number) =>
  request<{ ok: true }>(`/blocked-recipients/${id}`, { method: "DELETE" });

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchBoard = () => request<Board>("/board");

export const createBoardColumn = (name: string) =>
  request<BoardColumn>("/board/columns", jsonBody("POST", { name }));

export const renameBoardColumn = (id: number, name: string) =>
  request<BoardColumn>(`/board/columns/${id}`, jsonBody("PATCH", { name }));

export const reorderBoardColumns = (ids: number[]) =>
  request<Board>("/board/columns/order", jsonBody("PUT", { ids }));

export const deleteBoardColumn = (id: number) =>
  request<{ ok: true }>(`/board/columns/${id}`, { method: "DELETE" });

export const createBoardCard = (input: BoardCardInput) =>
  request<BoardCard>("/board/cards", jsonBody("POST", input));

export const updateBoardCard = (
  id: number,
  input: Pick<BoardCardInput, "title" | "description" | "due_at" | "due_time_zone" | "reminder_minutes">,
) =>
  request<BoardCard>(`/board/cards/${id}`, jsonBody("PATCH", input));

export const moveBoardCard = (id: number, columnId: number, index: number) =>
  request<Board>(`/board/cards/${id}/move`, jsonBody("POST", { column_id: columnId, index }));

export const deleteBoardCard = (id: number) =>
  request<{ ok: true }>(`/board/cards/${id}`, { method: "DELETE" });

export const linkBoardCard = (id: number, threadId: number) =>
  request<BoardCard>(`/board/cards/${id}/conversations`, jsonBody("POST", { thread_id: threadId }));

export const unlinkBoardCard = (id: number, threadId: number) =>
  request<BoardCard>(`/board/cards/${id}/conversations/${threadId}`, { method: "DELETE" });

export const fetchBoardCardSuggestions = (id: number) =>
  request<RelatedConversation[]>(`/board/cards/${id}/suggestions`);

export const fetchBoardCard = (id: number) => request<BoardCardDetail>(`/board/cards/${id}`);

export const addBoardCardNote = (id: number, body: string) =>
  request<BoardCardNote>(`/board/cards/${id}/notes`, jsonBody("POST", { body }));

export const deleteBoardCardNote = (id: number, noteId: number) =>
  request<{ ok: true }>(`/board/cards/${id}/notes/${noteId}`, { method: "DELETE" });

export const addThreadNote = (threadId: number, text: string, html: string) =>
  request<ThreadNote>(`/threads/${threadId}/notes`, jsonBody("POST", { text, html }));

export const deleteThreadNote = (threadId: number, noteId: number) =>
  request<{ ok: true }>(`/threads/${threadId}/notes/${noteId}`, { method: "DELETE" });
