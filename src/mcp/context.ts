/**
 * Shared context passed to every MCP tool and resource handler.
 */

import { resolveAgentDir } from '../isolation.js';

export interface McpContext {
  /** Absolute path to the memory directory (base dir in isolated mode). */
  memoryDir: string;
  /** Default agent ID used when not overridden per call. */
  defaultAgentId: string;
  /** Default session ID used when not overridden per call. */
  defaultSessionId: string;
  /** Whether per-agent isolation is active. */
  isolated: boolean;
}

export function resolveAgentId(ctx: McpContext, override?: string): string {
  return override ?? ctx.defaultAgentId;
}

export function resolveSessionId(ctx: McpContext, override?: string): string {
  return override ?? ctx.defaultSessionId;
}

/**
 * Resolve the effective memory directory for a tool call.
 * In shared mode, returns ctx.memoryDir. In isolated mode, routes to agent subdir.
 * Passes a pre-built config to avoid redundant disk reads on the MCP hot path.
 */
export function resolveMemoryDir(ctx: McpContext, agentId: string): string {
  if (!ctx.isolated) return ctx.memoryDir;
  return resolveAgentDir(ctx.memoryDir, agentId, { isolation: 'per-agent' });
}
