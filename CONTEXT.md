# Mailroom

Mailroom is a shared email workspace where people and agents handle customer conversations through the same inboxes.

## Language

**Inbox**:
A manually registered customer-facing email address under one ready Domain, with its own agent configuration and collection of conversations. The address is its sole identity; mail sent to an unregistered address is not part of the workspace unless its Domain has a Catch-all. An Inbox may carry a Sender Name (for example "Jane Doe from Acme") that recipients see in the From header of every reply and new email it sends; without one, mail shows only the address.
_Avoid_: Mailbox, account, inbox account

**Signature**:
Rich text (bold, italic, links, lists) appended to every reply and new email an Inbox sends, whether written by a person, an approved Agent Draft or the MCP Server. The workspace has one default Signature; each Inbox uses the default, its own Signature, or none. Plain-text recipients see it after a "-- " line. A Reply or Send Attempt keeps the Signature it was created with, so a retry sends the same email. Rule Forwards and Email Notifications carry no Signature.
_Avoid_: Footer, sign-off

**Rich Text**:
The formatting people use when writing replies, new emails and Signatures: bold, italic, underline, strikethrough, links and lists. It is stored and sent as allowlisted HTML, with the plain-text part derived from it so both always match. Agent Drafts are plain text and become rich text once edited.
_Avoid_: RTF, HTML email, formatted mail

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

**Contact**:
A workspace-wide record of a person the Inboxes correspond with, identified by email address and carrying a name, company, phone and notes. With "Automatically create new contacts" on, an external sender whose name can be parsed from the From header becomes a Contact on their first inbound Message; Contacts can also be added and edited by hand. Deleting a Contact leaves its Conversations untouched. Recipient fields suggest matching Contacts.
_Avoid_: Customer, address book entry, sender

**Blocked Sender**:
A rule naming one sender address or one domain (which also covers its subdomains), applying to one Inbox or to all Inboxes. Inbound mail to a covered Inbox whose envelope sender or From address matches is rejected before anything is stored, so it never opens a Conversation, drafts, labels or notifies. "Block sender" in a Message's menu, after confirmation, blocks the address or domain of that Message's sender, or of another address on it such as a Cc'd one, on that Conversation's Inbox or on all Inboxes, and archives the blocked sender's open Conversations in that scope, this one included when they wrote to it. A rule for all Inboxes replaces the same sender's per-Inbox rules. A rule can never cover one of the workspace's own Inboxes or a public mailbox provider such as gmail.com.
_Avoid_: Spam filter, blacklist, banned sender

**Catch-all**:
The one Inbox per Domain that receives mail sent to any address on that Domain without an Inbox of its own, such as a different address for each service someone signs up to. Each caught Conversation records the address it was sent to, shows it, and replies from it. From a caught address, "Create inbox" registers it as its own Inbox and can move its caught Conversations over (their Labels stay behind), and "Block address" makes it a Blocked Address. Without a Catch-all, mail to unregistered addresses is rejected.
_Avoid_: Wildcard inbox, alias inbox

**Blocked Address**:
An address on one of the workspace's own Domains whose mail the Catch-all rejects before anything is stored, whoever sends it, for an address that leaked to spammers. Blocking it archives the open Conversations caught for it. An address with its own Inbox can't be blocked this way, and creating an Inbox for a Blocked Address removes the block.
_Avoid_: Blocked recipient, blacklisted alias

**Mail Rule**:
A deterministic filter for one Inbox or all Inboxes, checked against every stored inbound Message. Its conditions read as a flow: IF a list of conditions joined by AND (all must hold) or OR (any may hold), where an item can be a group joined by the other connector, as in "From is at domain vendor.com AND (Subject contains invoice OR Attachment name ends with .pdf)". A condition compares From, To, Cc, Subject, Body or Attachment name (contains, does not contain, is, is not, starts with, ends with, and "is at domain" for addresses, covering subdomains), or asks whether the Message has an attachment; inline images never count and text matching ignores case. A match applies every action it names: apply one of its Inbox's Labels, mark the Conversation read, archive it, skip the Draft Run, skip Browser and Email Notifications, or forward the Message to To, Cc and Bcc recipients. Actions of all matching rules combine, and run before drafting and notifications. Unlike a Label's natural-language condition, a Mail Rule never calls a model; unlike a Blocked Sender, the Message is still stored. Deleting a rule's Label leaves the rule without that action; deleting its Inbox deletes the rule.
_Avoid_: Filter, automation, playbook

**Rule Forward**:
One Mail Rule's forward of one inbound Message, sent from the Inbox that received it with the original's headers and text, as many of its attachments as the send limits allow, and Reply-To set to the original sender. A rule forwards a Message at most once, never to one of the workspace's own Inboxes, and never forwards an email that is itself a Rule Forward, so rules cannot loop. Forwards count against a workspace-wide daily limit; a failed forward is recorded and shown on its rule, not retried.
_Avoid_: Auto-forward, redirect

**Board**:
The workspace's one Kanban board, with Columns people add, rename, reorder and delete. It starts with To do, In progress and Done, and always keeps at least one Column. Deleting a Column deletes its Board Items but never their Conversations.
_Avoid_: Project, pipeline, task list

**Board Item**:
A card on the Board with a title and an optional description, in one Column, ordered within it by dragging. It can link any number of Conversations, and a Conversation can be on any number of Board Items; each Conversation shows the Board Items it is on. A Board Item suggests newer Conversations from the senders of the Conversations it links, and a Conversation offers the Board Items that track its latest sender. "Create board item" on a Message starts one titled from the Conversation's subject and linked to it. Deleting a Conversation removes its links and keeps the Board Items.
_Avoid_: Task, ticket, card

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
The ordered email exchange grouped under one customer request. An archived Conversation can be permanently deleted, one at a time, in bulk, or all at once with "Empty archive"; this removes its Messages, Attachments, drafts, Draft Runs, Reply and Send Attempts and stored email objects, while Contacts stay. Only archived Conversations with no email still sending can be deleted.
_Avoid_: Ticket, chat

**Browser Notifications**:
A workspace-wide opt-in that sends a new-email notification to every subscribed browser, across all Inboxes. Each browser maintains its own Push Subscription; turning the global setting off disables delivery and clears all stored subscriptions.
_Avoid_: Inbox notifications, notification channel

**Email Notifications**:
A workspace-wide opt-in that sends a short new-email notice to one external email address, across all Inboxes. Its template (sender name, sending Inbox, subject and body with `{{placeholder}}` values) is editable; by default the notice is sent from the Inbox that received the email. It is marked auto-generated; mail from any Inbox never produces a notice.
_Avoid_: Forwarding, digest, alert email
