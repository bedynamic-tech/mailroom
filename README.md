# Mailroom

A self-hosted email system shared by humans and AI agents. Humans read, compose, and reply
through a Gmail-style web UI; agents read and send through MCP. Inbound mail
can be triaged with automatic labels and answered by an agent-drafted reply,
held for one-click human approval.

Runs entirely on Cloudflare: Workers, Email Routing, D1, R2, and Web Push.

![Mailroom: three inboxes in one workspace, with an agent draft awaiting approval](docs/screenshot.png)

## Features

- **Unified inbox** — manage multiple email addresses and domains in one workspace.
- **Compose and reply** — send new emails or reply to conversations, with attachments.
- **AI reply drafts** — enable per-inbox drafting with custom instructions and playbooks; review and approve before sending.
- **Automatic labels** — organize incoming mail with natural-language labeling rules.
- **Search and triage** — search message content, filter conversations, mark read or archive in bulk, and browse or restore archived conversations.
- **MCP integration** — let external AI agents read conversations, compose emails, and send replies through scoped OAuth access.
- **Browser notifications** — opt in to Web Push alerts for new messages.
- **Self-hosted on Cloudflare** — run in your own account, with Cloudflare Access protecting the web app.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wong2/cf-mailroom)

Deploy Mailroom into your own Cloudflare account, with storage and drafting
queues provisioned for you and database migrations applied automatically.
Then open the app: its setup screen walks you through turning on Cloudflare
Access. After that, connect your email domain. The MCP server ships in the same
Worker; browser notifications are optional.

**Start here: [Cloudflare deployment guide](docs/deployment.md).** You need a
domain on Cloudflare, R2 enabled, and Workers Paid for outbound email. The
deploy button requires this repository to be public.

## Architecture

```
inbound email ──► Email Routing ──► email() handler ──► D1 + R2 (raw MIME / attachments)
                                                          │
                                              Queue ──► Draft Run ──► Agent Draft
                                                          │
web UI (React SPA) ──► /api (Hono) ───────────────────────┤
external agents ──► OAuth 2.1 ──► /mcp (MCP 2026-07-28) ─┤
                              └─ /authorize ──► Access (same app as web UI)
outbound Reply Attempt ──► Cloudflare Email Sending ──────┤
outbound Send Attempt ──► Cloudflare Email Sending ───────┘
new inbound Message ──► Web Push ──► subscribed browsers
```

- **Multiple inboxes, one workspace.** Every receiving address is a row in
  `mailboxes`; the unified view queries across all of them. Mailboxes are added
  explicitly in Settings, and unknown recipient addresses are rejected. Each
  mailbox has its own instructions. AI drafting stays off until you enable
  **Draft replies to new messages**; that writes a draft for approval and never
  sends on its own.
- **Threading** follows RFC headers (`In-Reply-To` / `References`) with a
  sender-aware, reply-only normalized-subject fallback. New inbound mail
  reopens an archived Conversation.
- **Loop prevention**: auto-submitted senders (RFC 3834, `Precedence: bulk`,
  list mail) are flagged and must never receive automated replies.
- **Reliable drafting**: each latest inbound Message gets a retryable Draft Run
  on Cloudflare Queues. Stale runs cannot overwrite a newer Agent Draft.
- **At-most-once replies**: every approved send is a durable Reply Attempt.
  Browser retries reuse it rather than sending the customer another email.
- **Compose new mail**: choose a sending Inbox, enter one recipient, a subject,
  and a message or attachments. Successful sends open their new Conversation.
  Closing the composer keeps its draft in memory until the page is reloaded or
  closed; uncertain sends reuse the same attempt when checking their status.
- **MCP sends stay visible**: external agents use durable Reply/Send Attempts,
  so new mail and replies are written to the same Conversations the Web UI
  reads. Stable idempotency keys prevent retries from sending twice.
- **Attachments and Reply-To**: inbound files are stored in R2 and downloadable
  from the Conversation; outbound replies and new mail can carry attachments
  (≤3 MB total, staged in R2 alongside the attempt) and replies prefer the
  sender's `Reply-To` address.
- **Auto labels**: each Inbox can define labels (e.g. `guest-post`,
  `link-exchange`) with a natural-language match condition. New inbound mail is
  evaluated once with the `typesafe/jev` model and tagged with every matching
  label; replies are never labeled. The conversation list filters by label and
  supports multi-select mark-read/archive.

## Setup

For production, use the [deployment guide](docs/deployment.md). For local development
(Node.js 22.18+ or 24+):

```sh
npm ci
cp .dev.vars.example .dev.vars

# Local resources are emulated; no Cloudflare login or resource creation needed.
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

> Local development uses `wrangler.dev.jsonc`, which omits the AI and outbound
> email bindings. Inbound handling, the API, and the web UI remain available;
> sending a real reply requires the deployed Worker.

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

### Test the inbound pipeline locally

With `npm run dev` running (Vite on port 5173):

```sh
npm run email:test
npm run email:test:attachment
```

This POSTs `scripts/test-email.eml` to the local email handler. Use `npm run dev`,
not `npx wrangler dev`: the test always targets port 5173 and `wrangler.dev.jsonc`.

### Web routes

- `/inbox` and `/inbox/:threadId` — unified inbox and a selected conversation
- `/mailboxes/:mailboxId` — one Inbox
- `/mailboxes/:mailboxId/threads/:threadId` — a conversation within that Inbox
- `/settings/inboxes/:mailboxId` — Base Instructions and Playbooks for an Inbox
- `/settings/general` — workspace-wide settings, including browser notifications

Search and conversation filters are URL parameters (`?q=...&filter=unread|drafts`),
so refresh, browser history, and shared links preserve the current view.

> **Security note**: protect the Worker with [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
> and configure `WEB_ACCESS_TEAM_DOMAIN` and `WEB_ACCESS_AUD`; the app's setup
> screen shows both values (see [deployment setup](docs/deployment.md#2-protect-the-web-app-before-adding-email)).
> The production API independently verifies Access JWTs and rejects requests
> when authentication is missing or misconfigured. Writes also require an exact
> same-origin `Origin` header. Local development uses a separate entrypoint.

Browser notifications are off by default. Deployment automatically provisions
VAPID keys and uses the deploying Cloudflare user's email as the push contact
(an existing `VAPID_SUBJECT` is preserved). Turn notifications on under
**Settings → General**. Every browser that should receive
notifications must grant permission and subscribe once; turning the global
switch off removes all stored subscriptions.

## MCP server

The MCP server runs in the same Worker as the web app, at
`https://<your-hostname>/mcp`. It calls the Inbox domain modules directly and
does not proxy or expose the Web API. The server URL is shown in
**Settings → General**.

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
