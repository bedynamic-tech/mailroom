export const MCP_ROUTE = "/mcp";

// Under /mcp so one Access Bypass path covers the resource and these endpoints.
export const MCP_TOKEN_ENDPOINT = "/mcp/oauth/token";
export const MCP_REGISTRATION_ENDPOINT = "/mcp/oauth/register";

/**
 * OAuthProvider uses prefix matching for API routes. Keep the public endpoint
 * exact so `/mcp/`, `/mcpx`, and `/mcp/tools` cannot be mistaken for this MCP
 * resource. The OAuth endpoints are the only other paths allowed under it.
 */
export function isRejectedMcpRouteLookalike(pathname: string): boolean {
  return (
    pathname.startsWith(MCP_ROUTE) &&
    pathname !== MCP_ROUTE &&
    pathname !== MCP_TOKEN_ENDPOINT &&
    pathname !== MCP_REGISTRATION_ENDPOINT
  );
}
