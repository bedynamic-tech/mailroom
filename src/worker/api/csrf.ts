import type { MiddlewareHandler } from "hono";

/** Cookie-authenticated writes must originate from this web app. */
export const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const fetchSite = c.req.header("Sec-Fetch-Site");
    if (
      origin !== new URL(c.req.url).origin ||
      (fetchSite !== undefined && fetchSite !== "same-origin")
    ) {
      return c.json({ error: "Cross-origin requests are not allowed" }, 403);
    }
  }
  await next();
};
