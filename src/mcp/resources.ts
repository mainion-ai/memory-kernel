/**
 * MCP resource registrations for Memory Kernel.
 * 4 resources: decisions, constraints, handoff, open_questions.
 * Each reads the corresponding view file from memoryDir on every request.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readView } from '../store.js';
import { resolveMemoryDir, type McpContext } from './context.js';

const PLACEHOLDER = '# (not yet generated — run reflect first)\n';

function safeReadView(memoryDir: string, viewName: string): string {
  try {
    return readView(memoryDir, viewName);
  } catch {
    return PLACEHOLDER;
  }
}

// Exported handler functions for direct use in contract tests (no transport needed).

export async function handleDecisionsResource(
  ctx: McpContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  return {
    contents: [{
      uri: 'memory://decisions',
      mimeType: 'text/markdown',
      text: safeReadView(resolveMemoryDir(ctx, ctx.defaultAgentId), 'DECISIONS.md'),
    }],
  };
}

export async function handleConstraintsResource(
  ctx: McpContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  return {
    contents: [{
      uri: 'memory://constraints',
      mimeType: 'text/markdown',
      text: safeReadView(resolveMemoryDir(ctx, ctx.defaultAgentId), 'CONSTRAINTS.md'),
    }],
  };
}

export async function handleHandoffResource(
  ctx: McpContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  return {
    contents: [{
      uri: 'memory://handoff',
      mimeType: 'text/markdown',
      text: safeReadView(resolveMemoryDir(ctx, ctx.defaultAgentId), 'HANDOFF.md'),
    }],
  };
}

export async function handleOpenQuestionsResource(
  ctx: McpContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  return {
    contents: [{
      uri: 'memory://open-questions',
      mimeType: 'text/markdown',
      text: safeReadView(resolveMemoryDir(ctx, ctx.defaultAgentId), 'OPEN_QUESTIONS.md'),
    }],
  };
}

export function registerResources(server: McpServer, ctx: McpContext): void {
  server.registerResource(
    'decisions',
    'memory://decisions',
    {
      title: 'Decision Log',
      description: 'All accepted and draft decisions recorded in this memory store.',
      mimeType: 'text/markdown',
    },
    async (_uri) => handleDecisionsResource(ctx),
  );

  server.registerResource(
    'constraints',
    'memory://constraints',
    {
      title: 'Constraints',
      description: 'Active constraints and rules governing this project or session.',
      mimeType: 'text/markdown',
    },
    async (_uri) => handleConstraintsResource(ctx),
  );

  server.registerResource(
    'handoff',
    'memory://handoff',
    {
      title: 'Handoff',
      description: 'Current working state and priority atoms for cross-session continuity.',
      mimeType: 'text/markdown',
    },
    async (_uri) => handleHandoffResource(ctx),
  );

  server.registerResource(
    'open_questions',
    'memory://open-questions',
    {
      title: 'Open Questions',
      description: 'Unresolved open questions tracked in this memory store.',
      mimeType: 'text/markdown',
    },
    async (_uri) => handleOpenQuestionsResource(ctx),
  );
}
