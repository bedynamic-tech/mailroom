import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api";
import { requireWebAccess } from "./api/access.ts";
import { processDraftRun } from "./agent/draft";
import { receiveEmail } from "./email/receive";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireWebAccess);
app.route("/api", api);

export default {
  fetch: withMcp(app),
  email: receiveEmail,
  async queue(batch: MessageBatch<{ runId: number }>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          await processDraftRun(env, message.body.runId);
          message.ack();
        } catch {
          message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env, { runId: number }>;
