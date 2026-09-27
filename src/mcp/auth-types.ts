export const MCP_READ_SCOPE = "inbox.read";
export const MCP_SEND_SCOPE = "inbox.send";
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_SEND_SCOPE] as const;

export interface OAuthGrantProps extends Record<string, unknown> {
  email: string;
  sub: string;
  clientId: string;
  scopes: string[];
}

export interface McpIdentity {
  email: string;
  sub: string;
  clientId: string;
  canSend: boolean;
}
