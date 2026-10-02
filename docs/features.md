# Features

A detailed tour of everything Mailroom + does. For a quick overview, see the [README](../README.md).

## Mail

- **Unified inbox.** Manage multiple addresses and domains in one workspace.
- **Inboxes grouped by domain.** Under **All inboxes**, the sidebar lists each
  domain once, with its unread count. Click a domain to see the conversations
  of all its inboxes in one list, with search, filters, labels and the
  selection toolbar working across them. The arrow beside a domain shows or
  hides its inboxes, listed by the part before the `@`, and clicking one
  narrows the list to that inbox as before. Opening an inbox reveals it under
  its domain, and the sidebar remembers which domains are open.
- **Who each conversation is with.** The conversation list shows the name of
  the latest sender. In a conversation you started that nobody has answered
  yet, it shows **To** and the recipient's name, taken from their Contact, else
  from the name on mail they sent you before, else their address.
- **Compose and reply.** Send new mail or reply to conversations, with attachments.
- **Forward.** **Forward** in a message's menu opens a new email from the
  conversation's inbox with an empty To field, a "Fwd:" subject and the
  original quoted below a forwarded-message header (From, Date, Subject, To,
  Cc). The original's attachments and inline images come along, up to the
  10 file, 3 MB limit; any left out are named above the Send button.
- **Automatic links.** In the reply, compose, note and signature editors, web
  addresses (`https://...` or `www....`) and email addresses become links as
  soon as you type a space or start a new line after them, and when you leave
  the editor or send. A pasted address works the same way, and addresses in
  the middle of pasted text become links right away. Text typed after a link
  stays plain. Pasting an address over selected words turns those words into
  a link. Content pasted or
  dropped from a web page or another email keeps its links, formatting and
  web-hosted images.
- **Inline images.** Paste a screenshot or copied image into a reply or new
  email, or drop an image file on it, and it appears in the body where the
  cursor is. It is sent as an inline image inside the email rather than as a
  separate attachment. Large images are resized to at most 1600 pixels and
  saved as JPEG. Pasted images count toward the 10 file and 3 MB attachment
  limits. Notes and signatures do not take pasted images.
- **Choose who a reply goes to.** The reply box opens with an editable **To**
  field, filled with the sender of the latest email (or its Reply-To). In a
  conversation you started, it is filled with the address you sent to, so you
  can follow up before anyone answers. Remove or add To recipients before
  sending. **Cc**, **Bcc** and **Reply all** sit at
  the right of the To line and open their rows when tapped. Recipients you
  edit are saved with that conversation, so they stay after leaving, reloading
  or sending and on your other devices, and the next reply goes to the same
  people. The sparkle button
  at the right of the formatting toolbar drafts a reply with AI. Beside
  **Send reply**, the reply box shows which signature will be added:
  **Signature: Default** for the workspace default, or **Signature: Mailbox**
  when the Inbox has its own. On phones, scrolling back through a
  conversation folds the reply box into a round **Reply** button, keeping
  anything already written. Tap it, or scroll back down to the latest
  message, to open the reply box again.
- **Reply greeting.** Turn on **Add a greeting to replies** in
  **Settings > General** and each reply box starts with a greeting such as
  `Jane,` followed by a blank line, with the cursor on the line below, as if
  you had typed it and pressed Enter twice. The greeting is editable there;
  `{first_name}` stands for the first name of the first To recipient, taken
  from their contact or, failing that, the name on their latest email in the
  conversation (the default is `{first_name},`, and `Hi {first_name},` also
  works). When no name is known the reply starts empty. The greeting follows
  the To field until you edit the text, never replaces text you have written,
  and gives way to an AI draft. A reply holding only the greeting cannot be
  sent. It is off by default.
- **Send status and bounces.** Every email sent from Mailroom shows a small
  check at the bottom right of its card once the email provider has accepted
  it. When any recipient bounces, the check turns into a red exclamation
  point. Hover over it, or tap it on a phone, to see which
  address bounced and the receiving server's message. Bounces are tracked per
  recipient, so a Cc that bounces is shown even when the To was delivered.
  Cloudflare keeps bounce notices for itself, so Mailroom learns about bounces
  from Cloudflare's Email Sending events; subscribe each sending domain once
  as described in [docs/deployment.md](deployment.md#track-bounces).
  Adding an Inbox on a new domain lists this step in its setup checklist.
  Bounce notices that do reach an Inbox are read too.
- **Bounced address warnings.** When you add an address that has bounced
  before to To, Cc or Bcc, it turns red with a warning under the field, since
  sending to it again can hurt your sender reputation. Hover over it to see why
  it bounced. You can still send if you know the address works now.
- **Opens at the latest message.** A conversation opens scrolled to the bottom
  and stays there while emails and images finish loading, until you scroll up.
- **Internal notes.** Leave notes for your team on any conversation. Write in
  the reply box, then choose **Add internal note** from the arrow next to
  **Send reply**. Notes appear in yellow between the messages, in the order
  they were written, and can be deleted from their menu. Rules can add notes
  automatically. They are stored
  apart from email, so they are never sent, quoted in replies, forwarded by
  rules, read by AI drafts or the MCP server, or included in notifications.
  Attachments and Cc or Bcc recipients stay with the reply.
- **Search and triage.** Search message content, filter conversations, mark read,
  archive or mark senders as spam in bulk, and restore or permanently delete
  archived conversations.
- **Conversation menu.** The three dot menu at the top of a conversation
  has **Archive** (or **Move to inbox**) and **Delete**. Delete works whether
  the conversation is archived or not, asks for confirmation first, and
  permanently removes its messages, attachments, drafts and notes.
- **Universal search.** The search box in the top right (or Ctrl K / Cmd K,
  and the search icon on phones) finds conversations by subject, message text,
  sender or recipient, along with internal notes, rules (name, note,
  condition values and forward addresses) and contacts. Results are grouped
  by type, every word must match, and choosing one opens it: the
  conversation, the rule's editor or the contact.
- **Contacts.** Keep names, companies, phone numbers and notes, see each
  contact's conversations, and autocomplete them in To, Cc and Bcc. Give a
  contact several email addresses and edit them at any time: mail from any of
  them shows up under that contact, and new email goes to the one marked
  primary. A contact's name is used for its senders in the conversation list
  and on each message, in place of the name on the email. Import from CSV or
  vCard.
- **Catch-all.** Make one inbox per domain receive mail for any address that
  has no inbox of its own, such as a different address for each service you
  sign up to. Caught mail is badged and shows the address it was sent to,
  replies go out from that address, and any address can become its own inbox
  or be blocked if spammers find it. Choose **Archive in** instead of
  **Deliver to** to file caught mail straight into the Archive, read and
  without notifications or drafts, so it stays searchable without filling
  the inbox.
- **Light and dark mode.** Choose Light, Dark or System in **Settings >
  General > Appearance**. System follows your device, and the choice is saved
  on each device.
  In dark mode, simple emails are shown in dark colors on the app's own
  background, and emails that ship
  their own dark styles use them. Designed emails with their own backgrounds
  (newsletters, receipts) keep their original colors. Any text that would
  still be hard to read on its dark background is given a readable color. Any email can be
  switched from its **...** menu with **Show original colors** or **Show in
  dark colors**.
  Images an email shows in its body, such as signature logos, are not listed
  again as attachments.

## Automation

- **AI reply drafts.** Per-inbox drafting with custom instructions and
  playbooks. You review and approve before anything is sent.
- **Automatic labels.** Organize incoming mail with natural-language rules.
- **Rules.** Build IF / AND / OR conditions on sender, recipients, subject, body
  and attachments, then label, mark read, archive, skip drafts or
  notifications, forward, or add a note. **Add a note** opens a text box, and
  each matching email adds that text to its conversation as an internal note
  marked with the rule's name.
  **Permanently delete it** discards matching emails as they arrive: nothing
  is stored, notified, drafted or forwarded, the sender gets no bounce, and
  the email can't be recovered. A deleting rule takes no other action, and it
  wins over any other rule that matches the same email.
- **Spam blocking.** Block a sender by address or whole domain, on one inbox or
  all of them, from any message's menu. When a message has several people on
  it, such as Cc'd addresses, you choose which one to block. To clear out
  several at once, select conversations in the list and choose **Mark sender as
  spam** (the shield button): each one's sender is blocked by address, on its
  own inbox or on all inboxes, and their open conversations are archived.
  Blocked mail is rejected before it reaches Mailroom.

## Integrations

- **MCP server.** Let external AI agents read conversations, compose email and
  send replies through scoped OAuth access.
- **Notifications.** In **Settings > Notifications**, turn on browser push
  notifications, email notifications to one address, or both. Under each,
  checkboxes choose what it sends: **New email** (a new conversation) and
  **Replies** (a new message in an existing conversation), both checked
  by default. Browser push works in Chrome, Edge, Firefox and Safari. On
  iPhone and iPad, add Mailroom + to the Home Screen and turn notifications
  on from the app opened there. **Send test** under Browser notifications
  pushes a test notification and says whether it was sent.
- **Private by default.** Everything runs in your own account, with Cloudflare
  Access protecting the web app.

## MCP server tools

The MCP server ships in the same Worker at `https://<your-hostname>/mcp`, and
its URL is shown in **Settings > AI**. It is its own OAuth 2.1 authorization
server with `inbox.read` and `inbox.send` scopes.

| Tool | Scope |
| --- | --- |
| `list_inboxes` | `inbox.read` |
| `search_conversations` | `inbox.read` |
| `get_conversation` | `inbox.read` |
| `reply_to_conversation` | `inbox.send` |
| `send_email` | `inbox.send` |

Send tools only use inboxes already registered in Mailroom, require an
idempotency key, and are capped by `MCP_DAILY_SEND_LIMIT`. Set
`MCP_SEND_ENABLED=false` to turn them off for every client. Setup details are in
[connect an AI agent over MCP](deployment.md#optional-connect-an-ai-agent-over-mcp).

