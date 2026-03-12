/**
 * Shared context passed to every MCP tool and resource handler.
 */

export interface McpContext {
  /** Absolute path to the memory directory. */
  memoryDir: string;
  /** Default agent ID used when not overridden per call. */
  defaultAgentId: string;
  /** Default session ID used when not overridden per call. */
  defaultSessionId: string;
}

export function resolveAgentId(ctx: McpContext, override?: string): string {
  return override ?? ctx.defaultAgentId;
}

export function resolveSessionId(ctx: McpContext, override?: string): string {
  return override ?? ctx.defaultSessionId;
}
