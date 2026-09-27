import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api";
import worker from "./index";

// Only wrangler.dev.jsonc selects this entrypoint. Production has no auth bypass.
// MCP consent at /authorize still requires Access, so it is unavailable locally.
const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);

export default { ...worker, fetch: withMcp(app) };
