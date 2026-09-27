# Deploy your own Mailroom

The recommended path is Cloudflare's guided deployment, followed by Access and
email domain setup. No local CLI or API keys are needed for the initial web app.

## Before you start

- A GitHub account and a Cloudflare account.
- A domain using Cloudflare DNS for receiving and sending email.
- R2 enabled on the Cloudflare account (Cloudflare may ask for billing details).
- Workers Paid (~$5/month) for sending email to arbitrary recipients through
  [Email Sending](https://developers.cloudflare.com/email-service/).
- A Cloudflare Zero Trust team for protecting the web app with Access (the free
  plan is enough).

Workers, D1, R2, Queues, and Workers AI usage belongs to your account and is
subject to Cloudflare's quotas and billing. This is not a promise of free hosting.

## At a glance

1. Deploy with the button — storage, queues, and migrations are automatic.
2. Open the app and follow its setup screen: turn on Access for the Worker, then
   paste the two values it shows. The API rejects requests until this is done.
3. Connect your email domain (Email Routing in, Email Sending out).
4. Add an Inbox in Settings and send yourself a test email.
5. Optionally connect an agent over MCP (built in, at `/mcp`) and enable
   browser notifications.

## 1. Deploy the web app

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wong2/cf-mailroom)

1. Sign in to Cloudflare and connect GitHub when prompted. The source repository
   must be public for other users to use this button.
2. Choose the destination account, repository, and Worker name. For your first
   instance, the default names are fine. For additional instances, use different
   Worker, database, bucket, and queue names.
3. Review the resource bindings: `DB` (D1), `RAW` (R2), `AI` (Workers AI),
   `EMAIL` (Email Sending; onboard the sender domain after deploy — the binding
   does not verify it), `DRAFT_QUEUE`, and `DRAFT_DLQ` (two distinct queues),
   and `OAUTH_KV` (KV, for MCP OAuth clients and tokens).
   Cloudflare provisions the resources in your account and writes their values
   into your new repository.
   In `wrangler.jsonc`, the consumer's `queue` must match `DRAFT_QUEUE` and its
   `dead_letter_queue` must match `DRAFT_DLQ`, including if you rename them.

   The repository Cloudflare creates belongs to you — your instance lives there.
   Upstream changes do not arrive automatically; see [Updates](#updates).
4. Set the **deploy command** to `npm run deploy`. You can leave the **build
   command** empty because the deploy script builds the app itself. If Cloudflare
   pre-fills `npm run build`, clearing it avoids building twice.
5. Deploy and wait for Workers Builds to finish. The script builds the app,
   applies pending D1 migrations, then deploys the generated Worker and assets.
   It automatically creates missing browser notification credentials; no manual
   VAPID key generation is needed.

Cloudflare's [Deploy to Cloudflare documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
describes resource provisioning and repository creation. One Worker serves the
web app, inbound email, draft queue, and the MCP server.

### Database binding without an account-specific ID

The shared configs intentionally omit `database_id`. The project pins Wrangler
to 4.124.0, which resolves `database_name` in the authenticated Cloudflare account
for deployments and remote migrations. An existing database with that name is
reused. Use a distinct name for each independent instance in the same account.
No environment-variable injection script is needed.

The deployment button provisions resources before the deploy command runs. For
manual setup, create the database first as described below: this project's
deploy command runs migrations before uploading the Worker, and migrations
cannot create a missing database. If Cloudflare writes an explicit database ID
into your instance's config, keep it consistent with the database name; Wrangler
uses that ID when present.

## 2. Protect the web app before adding email

The web app uses Cloudflare Access for login and verifies its JWT on every API
request. Until that is configured, opening
`https://<worker>.<account>.workers.dev` shows a setup screen instead of the
inbox; the API denies every request. Do this step before registering an Inbox
or routing mail.

1. In [**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
   **→ your Worker → Access**, select **Enable access** under **Worker
   policies**. Choose **All traffic** and the **Cloudflare account** policy
   so only members of your account can sign in. Zero Trust must be enabled on
   the account (the free plan is enough). This protects every hostname of the
   Worker: `workers.dev`, custom domains, and previews.
2. Reload the app and sign in. The setup screen now shows the exact
   `WEB_ACCESS_TEAM_DOMAIN` and `WEB_ACCESS_AUD` values taken from your sign-in.
   Add both as **Text** variables in the Worker's **Settings → Variables and
   Secrets**.

   These values are not secrets. `keep_vars: true` preserves dashboard variables
   during Git-triggered deployments. Alternatively, define them in your instance's
   `wrangler.jsonc` `vars` object. Missing or invalid configuration fails closed.
3. Select **Check again**. The inbox opens once the Worker verifies your sign-in
   against those values.

`wrangler.jsonc` keeps `preview_urls` off; Worker-level Access would cover them,
but there is no reason to publish extra hostnames. A custom domain is optional;
list it in `routes` so it survives the next deploy. If you protect individual
hostnames with Self-hosted applications instead of the Worker-level toggle, put
every hostname in the **same** application so they share one AUD.

See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Access protects HTTP requests; it does not require inbound email or queue
events to sign in.

`npm run dev` selects `src/worker/dev.ts`, which skips JWT verification against
local test data; same-origin write checks still apply. Production selects
`src/worker/index.ts` and has no environment-variable or request-header bypass.
Do not deploy `wrangler.dev.jsonc` or expose the local dev server publicly.

## 3. Connect your email domain

1. Enable **Email Routing** for the receiving domain and install the DNS records
   Cloudflare requests. Check existing mail hosting before changing MX records.
   Do not point a routing rule at the Worker yet.
2. Enable **Email Sending** in Email Service and onboard the sender domain,
   completing the DNS verification shown by Cloudflare. The `EMAIL` Worker
   binding alone does not verify a domain or grant sending access.
3. In Mailroom **Settings**, add an Inbox such as `support@example.com`. For a
   new domain, the dialog asks you to confirm Email Routing is enabled and Email
   Sending is active before it saves the Inbox. Leave **Draft replies to new
   messages** off until delivery looks right. Turning it on writes a draft for
   your approval; nothing is sent automatically.
4. Then point that address (or a catch-all rule) at your deployed Worker using
   **Send to Worker**. Unknown recipient addresses are rejected, so a rule that
   exists before the Inbox bounces mail. A catch-all does not create Inboxes.
5. Send a message from an external mailbox, confirm it appears in the app, then
   reply and verify delivery back to that mailbox.

Repeat for additional addresses or domains; they can share the same Worker.

## Optional: connect an AI agent over MCP

The MCP server is built into the same Worker at `/mcp` and is deployed with
every push. Its OAuth state lives in the `OAUTH_KV` namespace that deployment
creates for you. The remaining step is to let MCP clients reach the OAuth
endpoints, which Access blocks because it protects the whole Worker.

1. Open **Settings → General** in Mailroom. The **AI agents (MCP)** card shows
   the server URL and checks whether the OAuth endpoints are publicly
   reachable.
2. If it says Access blocks them, go to
   [**Zero Trust → Access → Applications**](https://dash.cloudflare.com/?to=/:account/one/access-controls/apps)
   and add a **Self-hosted** application with these public hostname
   destinations (use your own hostname, not a Worker destination), with a
   single **Bypass** policy for **Everyone**:

   - `<worker>.<account>.workers.dev/mcp` (also covers the token and
     registration endpoints under `/mcp/oauth/`)
   - `<worker>.<account>.workers.dev/.well-known` (OAuth discovery; its
     location is fixed by the OAuth specifications)

   A path application takes precedence over Worker-level Access. Everything
   else, including the `/authorize` consent page, stays protected. Leave
   **Managed OAuth off**. Add the same two paths for each custom domain you use.
3. Select **Check again** in the card, then add the server URL
   (`https://<worker>.<account>.workers.dev/mcp`) to your MCP client and
   approve it.

On every consent request the Worker verifies the `Cf-Access-Jwt-Assertion`
against the same team, AUD, and signing keys as the web app before issuing a
grant, so anyone allowed into the web app can approve MCP clients. `/mcp` itself
only accepts OAuth access tokens. Each hostname is its own OAuth issuer, so
clients connected via `workers.dev` and a custom domain are authorized
separately.

`MCP_SEND_ENABLED=false` (a Worker variable) removes the send tools from every
client immediately. `MCP_DAILY_SEND_LIMIT` (default 100) caps MCP sends per
Access identity per UTC day.

## Optional: browser notifications

In **Settings → General**, enable browser notifications and grant permission in
each browser. No CLI or manual secret configuration is needed with the deployment
button's default build token.

The deploy script checks for `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK`. If both
are absent, it generates a P-256 key pair and uploads it as Worker Secrets with
the code using `wrangler deploy --secrets-file`. Keys exist only in a restricted
temporary file during deployment, which is removed afterward; they are never
committed to Git or printed by the script. Existing keys are preserved across
deploys so browser subscriptions continue to work. A failed lookup or an
incomplete key pair stops deployment instead of replacing existing keys.

An existing `VAPID_SUBJECT` Secret or Wrangler variable is also preserved.
Otherwise, the script uses the deploying Cloudflare user's email as the Web Push
contact (`mailto:…`). This contact is sent to browser push providers, not email
recipients. Workers Builds' default token includes the required User Details
read permission. For a custom token without access to a user email, or to choose
a different contact, set `VAPID_SUBJECT` in the **build environment** to a
`mailto:` address or HTTPS contact URL before the first deployment. The script
copies it to a runtime Secret. To change an existing contact, update the runtime
`VAPID_SUBJECT` in the Worker's Settings → Variables and Secrets.

Run deployments for a given instance sequentially, especially its first deploy,
so two initial builds cannot generate different key pairs simultaneously.
`npm run vapid:generate` remains available for manual setup or local development.

## Updates

Commit changes to the connected repository's production branch (normally `main`)
and push. Workers Builds runs `npm run deploy`, including pending database
migrations, for each production deployment. Keep your instance's resource IDs,
names, domains, and Access settings when bringing in upstream changes.

Do not point preview branches or a second instance at the production database
and queues. Schema migrations change stored data; a Worker rollback does not
undo a database migration.

### Pull upstream changes

The button created your own repository, so upstream fixes do not arrive
automatically. To update:

```sh
git remote add upstream https://github.com/wong2/cf-mailroom.git
git fetch upstream
git merge upstream/main
git push
```

Keep your own values when conflicts touch instance-specific files:
`wrangler.jsonc` holds your Worker and resource names.

### Upgrading from the separate MCP Worker

Earlier versions deployed MCP as a second Worker (`mailroom-mcp`, configured
by `wrangler.mcp.jsonc`). After updating, the main Worker serves MCP at
`https://<your-web-hostname>/mcp`, with its own KV namespace. Add the Bypass
application above, reconnect each MCP client to the new URL, then delete the
old `mailroom-mcp` Worker, its KV namespace, and its `/authorize` Access
application. The old Worker keeps working until you delete it. Existing grants
do not carry over.

## Manual setup / an existing fork

If you already forked the repository instead of using the button, create and
bind your own resources before connecting Workers Builds:

```sh
npm ci
npx wrangler login
npx wrangler d1 create mailroom
npx wrangler r2 bucket create mailroom-raw
npx wrangler queues create mailroom-drafts
npx wrangler queues create mailroom-drafts-dlq
```

No database ID needs to be copied: Wrangler looks up `database_name` in your
account. `OAUTH_KV` has no ID either; Wrangler creates it on the first deploy
and reuses it afterwards. If the database already exists, skip its create command and reuse it
only if it belongs to this instance. If you chose different resource names,
update the database, bucket, producer queues, consumer queue, and dead-letter
queue in `wrangler.jsonc`. Local development uses `wrangler.dev.jsonc` and does
not need a Cloudflare database.

Commit your instance configuration, connect that GitHub repository through
**Workers & Pages → Create → Import a repository**, and use `npm run deploy` as
the deploy command with an empty build command. Future production-branch pushes
deploy automatically. Continue with Access and domain setup above.

## Troubleshooting

- **Button cannot import the repository:** the upstream repository must be public.
- **A push did not trigger a deployment:** check that the repository is still
  connected under the Worker's **Settings → Build** and that the deploy command
  is `npm run deploy`. Builds only run on the production branch (normally
  `main`).
- **D1 database not found:** check the `DB` binding in your instance's config;
  `database_name` must match a database in the authenticated Cloudflare account.
  For manual setup, create it before running migrations. If an explicit
  `database_id` was added by Cloudflare, verify it matches that database too.
- **Local data appears empty after removing an old database ID:** Wrangler's
  local storage identity changes when the ID is removed. The previous local
  files remain under `.wrangler/state`; they are not deleted. Run
  `npm run db:migrate:local` to initialize the new local database and optionally
  `npm run db:seed:local` for demo data. Back up/export any local data you need
  before switching configurations; production data is unaffected.
- **Missing queue / dead-letter queue:** check both queues exist and the
  consumer names match the producer bindings, especially after renaming them.
- **R2 binding fails:** enable R2 in the destination account first.
- **App loads but replies fail:** check Email Sending access, the paid plan,
  sender-domain verification, and the Inbox's sending address.
- **Inbound mail does not appear:** check Email Routing targets this Worker and
  the recipient has already been added as an Inbox.
- **The setup screen keeps showing after adding variables:** saving variables
  redeploys the Worker; wait a few seconds and select **Check again**. If it
  says the values do not match, copy the values it shows now.
- **MCP OAuth redirects to Access before discovery:** add the Bypass
  application for `/mcp` and `/.well-known` on that hostname. The
  card in **Settings → General** confirms when it works.
