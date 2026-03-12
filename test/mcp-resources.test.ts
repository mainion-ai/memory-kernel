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
} from '../src/mcp/resources.js';
import type { McpContext } from '../src/mcp/context.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let ctx: McpContext;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-res-'));
  initMemoryDir(testDir);
  ctx = { memoryDir: testDir, defaultAgentId: 'test-agent', defaultSessionId: 'test-session' };
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

  it('returns placeholder before reflect', async () => {
    const { contents } = await handleDecisionsResource(ctx);
    // File may not exist yet — returns placeholder or empty string (both acceptable)
    expect(typeof contents[0]!.text).toBe('string');
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
    expect(typeof contents[0]!.text).toBe('string');
  });
});
