/**
 * #391 — MCP end-to-end over a real client↔server transport.
 *
 * Every other MCP test calls the handlers in-process. This one wires a real SDK
 * `Client` to the `McpServer` over an `InMemoryTransport` linked pair — the same
 * server-construction path as `src/mcp/server.ts` (registerTools/registerResources
 * → server.connect) — so the JSON-RPC framing, tool/resource schema marshalling,
 * and the connect handshake are actually exercised, not just the handler bodies.
 * In-memory (no child spawn) keeps it fast + deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initMemoryDir, listAtoms, closeAllIndexes } from '../src/index.js';
import { initAgentStore } from '../src/isolation.js';
import { registerTools } from '../src/mcp/tools.js';
import { registerResources } from '../src/mcp/resources.js';
import { resolveMemoryDir, type McpContext } from '../src/mcp/context.js';

// The transport handshake + JSON-RPC round-trips run in <1s solo, but can exceed
// the 10s default under full-suite parallel load (16 busy workers). Give this
// file headroom so it can't flake the gate; it's still fast in isolation.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });

let testDir: string;
// connect() assigns both before any use in every test; afterEach closes them
// defensively (optional-chaining + try/catch handles a partial-connect throw).
let client: Client;
let server: McpServer;

// vi.setConfig leaks across files sharing a worker, so restore the default
// timeouts once this file's tests finish.
afterAll(() => {
  vi.resetConfig();
});

async function connect(ctx: McpContext): Promise<void> {
  server = new McpServer({ name: 'memory-kernel', version: '0.8.0' });
  registerTools(server, ctx);
  registerResources(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'mk-e2e-test', version: '1.0.0' });
  await client.connect(clientTransport);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-e2e-'));
  initMemoryDir(testDir);
});

afterEach(async () => {
  try { await client?.close(); } catch { /* best-effort */ }
  try { await server?.close(); } catch { /* best-effort */ }
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('MCP transport E2E — shared mode', () => {
  const ctx = (): McpContext => ({ memoryDir: testDir, defaultAgentId: 'e2e-agent', defaultSessionId: 'e2e-session', isolated: false });

  it('listTools returns the registered tools with input schemas over the wire', async () => {
    await connect(ctx());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('mk_remember');
    expect(names).toContain('mk_recall');
    expect(names).toContain('mk_get_context_bundle');
    const remember = tools.find((t) => t.name === 'mk_remember')!;
    expect(remember.inputSchema).toBeDefined();
    // Marshalled Zod → JSON Schema: required fields surface as properties.
    expect(remember.inputSchema.properties).toHaveProperty('type');
    expect(remember.inputSchema.properties).toHaveProperty('slug');
    expect(remember.inputSchema.properties).toHaveProperty('body');
  });

  it('callTool mk_remember round-trips and writes the atom to disk', async () => {
    await connect(ctx());
    const result = await client.callTool({
      name: 'mk_remember',
      arguments: { type: 'fact', slug: 'paris', body: 'The capital of France is Paris.' },
    });
    expect(result.isError).toBeFalsy();
    // The write actually happened end-to-end (not just a handler return value).
    const atoms = listAtoms(testDir);
    expect(atoms.some((a) => a.frontmatter.id.includes('PARIS'))).toBe(true);
  });

  it('listResources + readResource return view content over the wire', async () => {
    await connect(ctx());
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('memory://decisions');
    const read = await client.readResource({ uri: 'memory://decisions' });
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]!.mimeType).toBe('text/markdown');
    expect(typeof read.contents[0]!.text).toBe('string');
  });

  it('readResource returns the PLACEHOLDER when the view path is unreadable', async () => {
    // Force a read error: make DECISIONS.md a directory (EISDIR) so safeReadView
    // falls back to the placeholder — exercised end-to-end through the transport.
    const decisions = path.join(testDir, 'DECISIONS.md');
    fs.rmSync(decisions, { force: true });
    fs.mkdirSync(decisions);
    await connect(ctx());
    const read = await client.readResource({ uri: 'memory://decisions' });
    expect(read.contents[0]!.text).toContain('not yet generated');
  });
});

describe('MCP transport E2E — isolated mode routing', () => {
  it('a remember call routes the write into the agent store', async () => {
    initAgentStore(testDir, 'alice');
    const ctx: McpContext = { memoryDir: testDir, defaultAgentId: 'alice', defaultSessionId: 'e2e-session', isolated: true };
    await connect(ctx);
    const result = await client.callTool({
      name: 'mk_remember',
      arguments: { type: 'fact', slug: 'isolated', body: 'Routed to the agent store.' },
    });
    expect(result.isError).toBeFalsy();
    // Lands in the agent subdir (the same routing the handler used), not the shared root.
    const agentDir = resolveMemoryDir(ctx, 'alice');
    expect(agentDir).not.toBe(testDir);
    expect(listAtoms(agentDir).some((a) => a.frontmatter.id.includes('ISOLATED'))).toBe(true);
    // And NOT in the shared root.
    expect(listAtoms(testDir).some((a) => a.frontmatter.id.includes('ISOLATED'))).toBe(false);
  });
});
