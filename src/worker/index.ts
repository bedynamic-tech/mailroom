import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api";
import { requireWebAccess } from "./api/access.ts";
import { processDraftRun } from "./agent/draft";
import { receiveEmail } from "./email/receive";
import { isEmailSendingEvent, recordSendingEvent, type EmailSendingEvent } from "./email/sending-events.ts";

// The draft queue also carries Cloudflare Email Sending events when a sending
// domain is subscribed to it, so bounces need no queue of their own.
type QueueBody = { runId: number } | EmailSendingEvent;

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireWebAccess);
app.route("/api", api);

export default {
  fetch: withMcp(app),
  email: receiveEmail,
  async queue(batch: MessageBatch<QueueBody>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          const body = message.body;
          if (isEmailSendingEvent(body)) await recordSendingEvent(env, body);
          else await processDraftRun(env, body.runId);
          message.ack();
        } catch {
          message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env, QueueBody>;
