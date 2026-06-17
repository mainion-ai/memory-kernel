/**
 * MCP resource contract tests — handler functions called directly (no transport needed).
 * Verifies resource URIs, MIME types, and content shape for all 4 resources.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, closeAllIndexes, reflect, createAtom } from '../src/index.js';
import {
  handleDecisionsResource,
  handleConstraintsResource,
  handleHandoffResource,
  handleOpenQuestionsResource,
  registerResources,
} from '../src/mcp/resources.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from '../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let ctx: McpContext;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-res-'));
  initMemoryDir(testDir);
  ctx = { memoryDir: testDir, defaultAgentId: 'test-agent', defaultSessionId: 'test-session', isolated: false };
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertResource(
  contents: Array<{ uri: string; mimeType: string; text: string }>,
  expectedUri: string,
) {
  expect(contents).toHaveLength(1);
  expect(contents[0]!.uri).toBe(expectedUri);
  expect(contents[0]!.mimeType).toBe('text/markdown');
  expect(typeof contents[0]!.text).toBe('string');
}

// ---------------------------------------------------------------------------
// decisions resource
// ---------------------------------------------------------------------------

describe('decisions resource', () => {
  it('returns correct URI and mime type', async () => {
    const { contents } = await handleDecisionsResource(ctx);
    assertResource(contents, 'memory://decisions');
  });

  it('returns the seeded view header before reflect', async () => {
    // initMemoryDir seeds DECISIONS.md with a view header (not empty), so readView
    // returns that content — distinct from the PLACEHOLDER path, which only fires
    // on a read error (see the 'view-read fallback' suite below).
    const { contents } = await handleDecisionsResource(ctx);
    expect(contents[0]!.text).toContain('# Decisions');
    expect(contents[0]!.text).not.toContain('not yet generated');
  });

  it('returns view content after reflect', async () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'decision',
      slug: 'use-typescript',
      body: 'Use TypeScript for all new code.',
    });
    reflect({ memoryDir: testDir, agent_id: 'test-agent', session_id: 'test-session' });
    expect(fs.existsSync(path.join(testDir, 'DECISIONS.md'))).toBe(true);
    const { contents } = await handleDecisionsResource(ctx);
    expect(contents[0]!.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// constraints resource
// ---------------------------------------------------------------------------

describe('constraints resource', () => {
  it('returns correct URI and mime type', async () => {
    const { contents } = await handleConstraintsResource(ctx);
    assertResource(contents, 'memory://constraints');
  });

  it('returns view content after reflect with constraints', async () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'constraint',
      slug: 'no-global-state',
      body: 'No global mutable state.',
    });
    reflect({ memoryDir: testDir, agent_id: 'test-agent', session_id: 'test-session' });
    const { contents } = await handleConstraintsResource(ctx);
    expect(contents[0]!.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// handoff resource
// ---------------------------------------------------------------------------

describe('handoff resource', () => {
  it('returns correct URI and mime type', async () => {
    const { contents } = await handleHandoffResource(ctx);
    assertResource(contents, 'memory://handoff');
  });

  it('returns view content after reflect', async () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'fact',
      slug: 'handoff-fact',
      body: 'A fact for handoff.',
    });
    reflect({ memoryDir: testDir, agent_id: 'test-agent', session_id: 'test-session' });
    expect(fs.existsSync(path.join(testDir, 'HANDOFF.md'))).toBe(true);
    const { contents } = await handleHandoffResource(ctx);
    expect(contents[0]!.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// open_questions resource
// ---------------------------------------------------------------------------

describe('open_questions resource', () => {
  it('returns correct URI and mime type', async () => {
    const { contents } = await handleOpenQuestionsResource(ctx);
    assertResource(contents, 'memory://open-questions');
  });

  it('returns view content after reflect with open questions', async () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'test-agent',
      session_id: 'test-session',
      type: 'open_question',
      slug: 'why-is-sky-blue',
      body: 'Why is the sky blue?',
    });
    reflect({ memoryDir: testDir, agent_id: 'test-agent', session_id: 'test-session' });
    const { contents } = await handleOpenQuestionsResource(ctx);
    expect(contents[0]!.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// safeReadView PLACEHOLDER fallback (#358)
// ---------------------------------------------------------------------------

describe('view-read fallback', () => {
  it('returns the placeholder when the view path cannot be read (readView throws)', async () => {
    // Make DECISIONS.md a directory so readFileSync throws EISDIR → safeReadView
    // returns the placeholder rather than propagating the error. (initMemoryDir
    // seeds it as an empty file, so remove that first.)
    const decisionsPath = path.join(testDir, 'DECISIONS.md');
    fs.rmSync(decisionsPath, { force: true });
    fs.mkdirSync(decisionsPath);
    const { contents } = await handleDecisionsResource(ctx);
    expect(contents[0]!.text).toContain('not yet generated');
  });
});

// ---------------------------------------------------------------------------
// registerResources wiring (#358)
// ---------------------------------------------------------------------------

describe('registerResources', () => {
  it('registers all 4 resources with correct names/uris/mime, and the callbacks resolve', async () => {
    const calls: Array<{ name: string; uri: string; meta: { mimeType?: string }; cb: (uri: unknown) => Promise<unknown> }> = [];
    const mockServer = {
      registerResource: (name: string, uri: string, meta: { mimeType?: string }, cb: (uri: unknown) => Promise<unknown>) => {
        calls.push({ name, uri, meta, cb });
      },
    } as unknown as McpServer;

    registerResources(mockServer, ctx);

    expect(calls.map((c) => c.name)).toEqual(['decisions', 'constraints', 'handoff', 'open_questions']);
    expect(calls.map((c) => c.uri)).toEqual([
      'memory://decisions',
      'memory://constraints',
      'memory://handoff',
      'memory://open-questions',
    ]);
    expect(calls.every((c) => c.meta.mimeType === 'text/markdown')).toBe(true);

    // Invoke each registered read callback — exercises the `async (_uri) => handleXResource(ctx)` arrows.
    for (const c of calls) {
      const result = (await c.cb('ignored-uri')) as { contents: Array<{ uri: string; mimeType: string }> };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]!.mimeType).toBe('text/markdown');
    }
  });
});
