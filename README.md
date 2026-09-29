<div align="center">

# Mailroom +

**A self-hosted shared inbox for humans and AI agents, running entirely on Cloudflare.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bedynamic-tech/mailroom)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-ready-6E56CF)

</div>
<img width="2800" height="1800" alt="inbox" src="https://github.com/user-attachments/assets/165cb260-af9b-4f4b-8541-bf391fc5deea" />

Mailroom + is a fork of the original Mailroom with a large set of features added
for everyday use. It runs in your own Cloudflare account on Workers, Email
Routing, D1, R2 and Web Push.

## Features

### Mail

- **Unified inbox.** Manage multiple addresses and domains in one workspace.
- **Compose and reply.** Send new mail or reply to conversations, with attachments.
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
- **Send status and bounces.** Every email sent from Mailroom shows **Sent**
  at the bottom right of its card once the email provider has accepted it.
  When a bounce notice comes back for any recipient, the mark turns into a red
  exclamation point labeled **Bounced**. Hover over it, or tap it on a phone,
  to see which address bounced and the receiving server's message. Bounces
  are tracked per recipient, so a Cc that bounces is shown even when the To
  was delivered. The bounce notice itself still arrives as its own email.
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
- **Search and triage.** Search message content, filter conversations, mark read
  or archive in bulk, and restore or permanently delete archived conversations.
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
  primary. Import from CSV or vCard.
- **Catch-all.** Make one inbox per domain receive mail for any address that
  has no inbox of its own, such as a different address for each service you
  sign up to. Caught mail is badged and shows the address it was sent to,
  replies go out from that address, and any address can become its own inbox
  or be blocked if spammers find it.
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

### Automation

- **AI reply drafts.** Per-inbox drafting with custom instructions and
  playbooks. You review and approve before anything is sent.
- **Automatic labels.** Organize incoming mail with natural-language rules.
- **Rules.** Build IF / AND / OR conditions on sender, recipients, subject, body
  and attachments, then label, mark read, archive, skip drafts or
  notifications, forward, or add a note. **Add a note** opens a text box, and
  each matching email adds that text to its conversation as an internal note
  marked with the rule's name.
- **Spam blocking.** Block a sender by address or whole domain, on one inbox or
  all of them, from any message's menu. When a message has several people on
  it, such as Cc'd addresses, you choose which one to block. Blocked mail is
  rejected before it reaches Mailroom.

### Integrations

- **MCP server.** Let external AI agents read conversations, compose email and
  send replies through scoped OAuth access.
- **Notifications.** In **Settings > Notifications**, turn on browser push
  notifications, email notifications to one address, or both. Under each,
  checkboxes choose what it sends: **New email** (a new conversation) and
  **Replies** (a new message in an existing conversation), both checked
  by default.
- **Private by default.** Everything runs in your own account, with Cloudflare
  Access protecting the web app.

## Deploy

Click **Deploy to Cloudflare** above. Storage, queues and database migrations
are provisioned for you, and the app's setup screen walks you through turning
on Cloudflare Access and connecting your email domain.

You will need:

- A domain on Cloudflare
- R2 enabled
- The Workers Paid plan (for outbound email)

Prefer to set things up by hand, or deploying from an existing fork? See the
[manual deployment guide](docs/deployment.md).

## MCP server

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
[connect an AI agent over MCP](docs/deployment.md#optional-connect-an-ai-agent-over-mcp).

## License

[Apache-2.0](LICENSE)
