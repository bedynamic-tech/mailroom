# Mailroom

Mailroom is a shared email workspace where people and agents handle customer conversations through the same inboxes.

## Language

**Inbox**:
A manually registered customer-facing email address under one ready Domain, with its own agent configuration and collection of conversations. The address is its sole identity; mail sent to an unregistered address is not part of the workspace.
_Avoid_: Mailbox, account, inbox account

**Domain**:
The shared email namespace inferred from an Inbox address. It becomes ready after inbound routing and outbound sending are configured; one ready Domain can support multiple Inboxes.
_Avoid_: Mailbox domain, sending domain

**All Inboxes**:
The unified view across every registered Inbox.
_Avoid_: Unified inbox, combined inbox

**Base Instructions**:
Inbox-wide product context and behavioral guidance applied to every agent-authored draft for that Inbox.
_Avoid_: System prompt, global prompt

**Playbook**:
Manually authored guidance for one recognizable support scenario, composed with the Inbox's Base Instructions when it matches a conversation.
_Avoid_: Template, canned response, rule

**Label**:
A per-Inbox named tag with a natural-language match condition. When a new inbound Message opens a Conversation, the `typesafe/jev` evaluation model checks every Label's condition and applies each match; replies in existing Conversations are never labeled. A Conversation can carry any number of Labels, and the conversation list can be filtered by Label.
_Avoid_: Tag, category, folder

**Agent Draft**:
A proposed reply authored by the agent and held for human review before sending.
_Avoid_: Auto-reply, suggestion

**Draft Run**:
One retryable attempt to produce an Agent Draft for a specific latest inbound Message. It ends with an Agent Draft, a failure, or an explicit skip; it never ends as an unlabelled absence.
_Avoid_: Agent job, generation task

**Unprocessed Message**:
An inbound Message for which no Draft Run exists. It is distinct from a skipped Draft Run because the agent never considered it.
_Avoid_: Empty result, no draft

**Reply Attempt**:
A durable human-approved intent to send one reply. Retrying the same Reply Attempt must never create another outbound Message.
_Avoid_: Send request, outbox item

**Send Attempt**:
A durable intent to send one new outbound Message from a registered Inbox. It owns idempotency, provider delivery, Conversation creation, and the outbound Message record. A retry of one Send Attempt must never create another email.
_Avoid_: API send, raw Cloudflare send

**MCP Server**:
The OAuth-protected adapter at `/mcp` through which external agents read Conversations and send email. It runs in the same Worker as the web app and calls the Inbox domain modules directly, but does not proxy or expose the Web API.
_Avoid_: MCP API, agent endpoint

**Access Identity**:
The owner identity verified from the Cloudflare Access assertion when an MCP client opens `/authorize`, using the same Access application as the web app. A Bypass application keeps OAuth discovery, registration, tokens, and the MCP resource publicly reachable; interactive consent stays behind Access. The owner subject is encrypted into the resulting grant and recorded on MCP-originated Reply and Send Attempts, while bearer tokens are never logged.
_Avoid_: MCP user, API key owner

**MCP Authorization Grant**:
The owner's explicit approval for one registered MCP client and its requested `inbox.read` / `inbox.send` scopes. The OAuth provider owns PKCE, short-lived access tokens, rotating refresh tokens, audience binding, narrowing, and revocation; tool availability follows the effective token scope.
_Avoid_: Access session, API key, global MCP permission

**Attachment**:
A file or inline resource carried by one Message and available to people for inspection or download.
_Avoid_: Upload, raw MIME

**Conversation**:
The ordered email exchange grouped under one customer request.
_Avoid_: Ticket, chat

**Browser Notifications**:
A workspace-wide opt-in that sends a new-email notification to every subscribed browser, across all Inboxes. Each browser maintains its own Push Subscription; turning the global setting off disables delivery and clears all stored subscriptions.
_Avoid_: Inbox notifications, notification channel
