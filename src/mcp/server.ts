#!/usr/bin/env node
/**
 * Memory Kernel MCP Server — exposes kernel operations as MCP tools and resources.
 *
 * Configuration via environment variables:
 *   MEMORY_DIR    (required) Absolute path to the memory directory
 *   MCP_AGENT_ID  (optional) Agent ID for audit trail, default: "mcp-server"
 *   MCP_SESSION_ID (optional) Session ID for audit trail, default: "mcp-<random>"
 *
 * Usage:
 *   MEMORY_DIR=/path/to/memory node dist/mcp/server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import type { McpContext } from './context.js';
import { isIsolated, initAgentStore } from '../isolation.js';

const rawDir = process.env['MEMORY_DIR'];
if (!rawDir) {
  console.error('Error: MEMORY_DIR environment variable is required');
  process.exit(1);
}

const memoryDir = path.resolve(rawDir);
if (!fs.existsSync(memoryDir)) {
  console.error(`Error: MEMORY_DIR does not exist: ${memoryDir}`);
  process.exit(1);
}

const isolated = isIsolated(memoryDir);
const defaultAgentId = process.env['MCP_AGENT_ID'] ?? 'mcp-server';

// Auto-init agent store in isolated mode
if (isolated) {
  initAgentStore(memoryDir, defaultAgentId);
}

const ctx: McpContext = {
  memoryDir,
  defaultAgentId,
  defaultSessionId: process.env['MCP_SESSION_ID'] ?? `mcp-${randomUUID().slice(0, 8)}`,
  isolated,
};

const server = new McpServer({
  name: 'memory-kernel',
  version: '0.8.0',
});

registerTools(server, ctx);
registerResources(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
