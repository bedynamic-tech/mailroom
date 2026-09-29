<div align="center">

# Mailroom +

### The shared inbox you own.

Email, helpdesk and AI agents in one workspace, running entirely in your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bedynamic-tech/mailroom)

![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-ready-6E56CF)

[Features](docs/features.md) · [Deploy](#get-started) · [Docs](docs/deployment.md)

<br />

<img width="2800" height="1800" alt="The Mailroom + inbox" src="https://github.com/user-attachments/assets/50f69feb-3920-43e5-aff9-9c4854678f52" />

</div>

<br />

## Why Mailroom +

<table>
<tr>
<td width="33%" valign="top">

**Every address, one inbox**

Bring all your domains and addresses into a single workspace your team shares, with catch-all, contacts and search built in.

</td>
<td width="33%" valign="top">

**AI that waits for you**

Draft replies with AI, sort mail with plain-language rules, and let agents work over MCP. Nothing is sent until you approve it.

</td>
<td width="33%" valign="top">

**Yours, end to end**

No SaaS vendor and no per-seat pricing. Your mail lives in your own Cloudflare account, behind Cloudflare Access.

</td>
</tr>
</table>

## Highlights

- **Shared inbox.** Conversations, internal notes, contacts and universal search in one place.
- **Delivery you can see.** Every sent email shows when it was accepted, and bounces are flagged per recipient.
- **Rules and automation.** Label, forward, archive, add notes or block spam automatically.
- **AI drafts.** Per-inbox instructions and playbooks, always reviewed before sending.
- **MCP server.** Give external AI agents scoped OAuth access to read and send.
- **Notifications.** Browser push and email alerts, on desktop and phone.

See the [full feature list](docs/features.md) for the details.

## Get started

1. **Deploy.** Click **Deploy to Cloudflare** above. Storage, queues and the database are set up for you.
2. **Secure.** The setup screen walks you through turning on Cloudflare Access.
3. **Connect.** Point your email domain at Mailroom + and start working.

You will need a domain on Cloudflare, R2 enabled, and the Workers Paid plan (for outbound email).
Prefer to set things up by hand? Follow the [manual deployment guide](docs/deployment.md).

## Built on

Cloudflare Workers, Email Routing, D1, R2, Workers AI and Web Push.
Mailroom + is a fork of the original Mailroom.

## License

[Apache-2.0](LICENSE)
