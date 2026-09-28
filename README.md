<div align="center">

# Mailroom +

**A self-hosted shared inbox for humans and AI agents, running entirely on Cloudflare.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bedynamic-tech/mailroom)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-ready-6E56CF)

</div>

<img width="2560" height="1640" alt="Mailroom + conversation view" src="docs/images/screenshot.png" />

Mailroom + is a fork of the original Mailroom with a large set of features added
for everyday use. It runs in your own Cloudflare account on Workers, Email
Routing, D1, R2 and Web Push.

## Features

### Mail

- **Unified inbox.** Manage multiple addresses and domains in one workspace.
- **Compose and reply.** Send new mail or reply to conversations, with attachments.
- **Search and triage.** Search message content, filter conversations, mark read
  or archive in bulk, and restore or permanently delete archived conversations.
- **Contacts.** Keep names, companies, phone numbers and notes, see each
  contact's conversations, and autocomplete them in To, Cc and Bcc. Import from
  CSV or vCard.
- **Catch-all.** Make one inbox per domain receive mail for any address that
  has no inbox of its own, such as a different address for each service you
  sign up to. Caught mail is badged and shows the address it was sent to,
  replies go out from that address, and any address can become its own inbox
  or be blocked if spammers find it.
- **Board.** Track work on a Kanban board from the sidebar. Add, rename,
  reorder and delete columns, add items with the plus on any column, and drag
  items between columns on desktop or phone (press and hold on a touch
  screen). Create an item from any message's menu in a conversation,
  prefilled from the subject, or add the conversation to an item already on
  the board. Opening an item shows its name, description, date added, column,
  timestamped notes you can add over time, and its related conversations. The
  Edit button changes the name, description and column, links or unlinks
  conversations, and deletes the item. Linking searches your mail and
  suggests new mail from the senders the item already tracks; a conversation
  from one of those senders offers to link itself to their item. Items link
  back to their conversations, and conversations show the items they are on,
  both in the list and above the messages.
- **Light and dark mode.** Choose Light, Dark or System in **Settings >
  General > Appearance**. System follows your device, and the choice is saved
  on each device.

<img width="2800" height="1800" alt="Catch-all conversations in Mailroom +" src="docs/images/catch-all.png" />

### Automation

- **AI reply drafts.** Per-inbox drafting with custom instructions and
  playbooks. You review and approve before anything is sent.
- **Automatic labels.** Organize incoming mail with natural-language rules.
- **Rules.** Build IF / AND / OR conditions on sender, recipients, subject, body
  and attachments, then label, mark read, archive, skip drafts or
  notifications, or forward.
- **Spam blocking.** Block a sender by address or whole domain, on one inbox or
  all of them, from any message's menu. When a message has several people on
  it, such as Cc'd addresses, you choose which one to block. Blocked mail is
  rejected before it reaches Mailroom.

### Integrations

- **MCP server.** Let external AI agents read conversations, compose email and
  send replies through scoped OAuth access.
- **Notifications.** Opt in to browser push alerts, or a notice email to one
  address.
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
