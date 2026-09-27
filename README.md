# Mailroom +

A fork of the original Mailroom, but with a massive amount of features added for everyday use by humans and AI integrated.

Runs entirely on Cloudflare: Workers, Email Routing, D1, R2, and Web Push.

<img width="2880" height="1800" alt="image" src="https://github.com/user-attachments/assets/34079ed5-8eff-41fc-86c6-d51013dd5d16" />

## Features

- **Unified inbox** — manage multiple email addresses and domains in one workspace.
- **Compose and reply** — send new emails or reply to conversations, with attachments.
- **AI reply drafts** — enable per-inbox drafting with custom instructions and playbooks; review and approve before sending.
- **Automatic labels** — organize incoming mail with natural-language labeling rules.
- **Rules**: build IF / AND / OR conditions on sender, recipients (To, Cc), subject, body and attachments, then apply a label, mark read, archive, skip the AI draft, skip notifications, or forward to To, Cc and Bcc recipients. Manage rules under **Settings → Rules**.
- **Contacts** — keep names, companies, phone numbers and notes for the people who email you, see their conversations, and pick them from autocomplete in To/Cc/Bcc. Named senders can be added automatically, and contacts can be imported from CSV or vCard files.
- **Spam blocking** — block a conversation's sender by address or whole domain, on that inbox or on all inboxes; mail from blocked senders is rejected before it reaches Mailroom. Manage the blocklist under **Settings → Spam**.
- **Search and triage** — search message content, filter conversations, mark read or archive in bulk, browse or restore archived conversations, and permanently delete them one at a time, in bulk, or with Empty archive.
- **MCP integration** — let external AI agents read conversations, compose emails, and send replies through scoped OAuth access.
- **Browser notifications** — opt in to Web Push alerts for new messages.
- **Email notifications** — optionally send a notice to one email address for new messages.
- **Self-hosted on Cloudflare** — run in your own account, with Cloudflare Access protecting the web app.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bedynamic-tech/mailroom)

Deploy Mailroom into your own Cloudflare account, with storage and drafting
queues provisioned for you and database migrations applied automatically.
Then open the app: its setup screen walks you through turning on Cloudflare
Access. After that, connect your email domain. The MCP server ships in the same
Worker; browser notifications are optional.

**Start here: [Cloudflare deployment guide](docs/deployment.md).** You need a
domain on Cloudflare, R2 enabled, and Workers Paid for outbound email. The
deploy button requires this repository to be public.

### Connect a receiving domain

Production setup, including Access, is in the [deployment guide](docs/deployment.md).
For each domain that should receive mail:

1. Move the domain's DNS to Cloudflare and enable **Email Routing**. Install the
   DNS records Cloudflare asks for. Do not point a routing rule at the Worker yet.
2. Onboard the domain in **Email Sending** (dashboard → Email Service → Sending)
   so replies can be sent from it. Requires the Workers paid plan while Email
   Sending is in beta.
3. Add the Inbox in **Settings**. The app infers its Domain and asks you to
   confirm those Cloudflare steps only when that Domain has not been confirmed
   before. New inboxes leave **Draft replies to new messages** off.
4. Then point that address (or a catch-all) at **Send to Worker → your Mailroom
   Worker**. Unknown recipient addresses are rejected, so a rule that arrives
   before the Inbox bounces mail. A catch-all does not create Inboxes. Multiple
   domains can share this one Worker.

## MCP server

The MCP server runs in the same Worker as the web app, at
`https://<your-hostname>/mcp`. It calls the Inbox domain modules directly and
does not proxy or expose the Web API. The server URL is shown in
**Settings → AI**.

It uses the stateless MCP `2026-07-28` handler and keeps compatibility with
published 2025 stateless clients. Its tools are:

- `list_inboxes`
- `search_conversations`
- `get_conversation`
- `reply_to_conversation`
- `send_email`

The two send tools are an explicit owner-level capability: they send
immediately, require a stable `idempotency_key`, and only send from an Inbox
already registered in Mailroom. Replies require the exact inbound Message
and reviewed reply target, then calculate RFC threading on the server. Send
Attempts are limited to `MCP_DAILY_SEND_LIMIT` per Access identity per UTC day.

The MCP Worker is its own OAuth 2.1 authorization server. It supports Client ID
Metadata Documents (the MCP 2026 preferred registration mechanism) and Dynamic
Client Registration as a compatibility fallback, so standards-compliant MCP
clients do not need their callback URLs preconfigured. Authorization Code uses
S256 PKCE; access tokens last 15 minutes and refresh tokens last 30 days.

Tokens have real `inbox.read` and `inbox.send` scopes. Read access is required;
the two write tools are registered only when the token includes `inbox.send`,
and the instance-level emergency switch `MCP_SEND_ENABLED` is not `false`. Set
that variable to `false` to remove write tools from every client immediately.

### Enable the MCP server

MCP is deployed with the app. Access protects the whole Worker, so MCP clients
need a Bypass application for `/mcp` and `/.well-known`; the consent
page at `/authorize` stays behind the same Access application as the web UI.
See [connect an AI agent over MCP](docs/deployment.md#optional-connect-an-ai-agent-over-mcp).

## Roadmap

- [x] Triage: per-inbox auto labels via `typesafe/jev` classification on new inbound mail
- [ ] External tools for the draft agent (for example Stripe or product databases)
- [ ] Delivery and bounce status inside the Conversation (available today in Cloudflare Email Logs)
- [x] Full-text search in the conversation list (`/api/search` on `messages_fts`)

## License

Apache-2.0
