/**
 * MCP isolation tests — verify tool handlers route to correct agent stores
 * in per-agent isolation mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initIsolatedBase,
  initAgentStore,
  createAtom,
  closeAllIndexes,
  openIndex,
} from '../src/index.js';
import {
  handleRemember,
  handleRecall,
  handleListConflicts,
  handleShareAtom,
  handleUnshareAtom,
  handleGetContextBundle,
} from '../src/mcp/tools.js';
import { shareAtom } from '../src/share.js';
import type { McpContext } from '../src/mcp/context.js';

let testDir: string;

function isoCtx(agentId: string): McpContext {
  return {
    memoryDir: testDir,
    defaultAgentId: agentId,
    defaultSessionId: 'test-session',
    isolated: true,
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

function expectError(result: { content: Array<{ type: string; text: string }>; isError?: boolean }, substring: string) {
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain(substring);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mcp-iso-'));
  initIsolatedBase(testDir, 'alpha');
  initAgentStore(testDir, 'alpha');
  initAgentStore(testDir, 'beta');
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('MCP isolation — remember routes to agent store', () => {
  it('remember writes atom to agent-specific directory', async () => {
    const ctx = isoCtx('alpha');
    const result = await handleRemember(ctx, {
      type: 'fact',
      slug: 'alpha-fact',
      body: 'Alpha knows this.',
    });
    const data = parseResult(result);
    expect(data.atom.filePath).toContain(path.join('agents', 'alpha'));
    expect(fs.existsSync(data.atom.filePath)).toBe(true);
  });

  it('different agents get different stores', async () => {
    const ctxA = isoCtx('alpha');
    const ctxB = isoCtx('beta');

    const resA = await handleRemember(ctxA, { type: 'fact', slug: 'a-fact', body: 'A.' });
    const resB = await handleRemember(ctxB, { type: 'fact', slug: 'b-fact', body: 'B.' });
    const dataA = parseResult(resA);
    const dataB = parseResult(resB);

    expect(dataA.atom.filePath).toContain(path.join('agents', 'alpha'));
    expect(dataB.atom.filePath).toContain(path.join('agents', 'beta'));
  });
});

describe('MCP isolation — recall scoped to agent', () => {
  it('recall returns only the calling agent atoms', async () => {
    const alphaDir = path.join(testDir, 'agents', 'alpha');
    const betaDir = path.join(testDir, 'agents', 'beta');
    openIndex(alphaDir);
    openIndex(betaDir);

    createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'alpha-secret',
      body: 'Alpha secret info.',
    });
    createAtom({
      memoryDir: betaDir,
      agent_id: 'beta',
      session_id: 'test',
      type: 'fact',
      slug: 'beta-secret',
      body: 'Beta secret info.',
    });

    const ctx = isoCtx('alpha');
    const result = await handleRecall(ctx, { task: 'secret' });
    const data = parseResult(result);

    const bodies = data.atoms.map((a: { body: string }) => a.body);
    expect(bodies.some((b: string) => b.includes('Alpha'))).toBe(true);
    expect(bodies.some((b: string) => b.includes('Beta'))).toBe(false);
  });
});

describe('MCP isolation — get_context_bundle merges shared atoms', () => {
  it('get_context_bundle returns agent + shared atoms in isolated mode', async () => {
    const alphaDir = path.join(testDir, 'agents', 'alpha');
    const sharedDir = path.join(testDir, 'shared');
    openIndex(alphaDir);
    openIndex(sharedDir);

    const alphaAtom = createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'alpha-only',
      // Body literally mentions the task keyword so FTS-matches the
      // `task: 'deployment'` query below. Pre-#214 the scope.tags
      // alone was enough because the score-0 fallback surfaced every
      // status-filtered atom; that path is gone — the body now has
      // to hit FTS for the atom to surface.
      body: 'Alpha private knowledge about deployment.',
      scope: { tags: ['deployment'] },
    });
    // Seed shared namespace via the supported share flow so indices stay consistent
    const sharedSrc = createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'team-shared',
      body: 'Team-shared knowledge about deployment.',
      scope: { tags: ['deployment'] },
    });
    shareAtom(testDir, sharedSrc.frontmatter.id, 'alpha', { agent_id: 'alpha', session_id: 'test' });

    const ctx = isoCtx('alpha');
    const result = await handleGetContextBundle(ctx, { task: 'deployment', skip_reflect: true });
    const data = parseResult(result);

    expect(data.atom_count).toBeGreaterThanOrEqual(2);
    expect(data.markdown).toContain(alphaAtom.frontmatter.id);
    expect(data.markdown).toContain(sharedSrc.frontmatter.id);
  });
});

describe('MCP isolation — list_conflicts scoped to agent', () => {
  it('lists conflicts only from the specified agent store', async () => {
    const ctx = isoCtx('alpha');
    const result = await handleListConflicts(ctx, {});
    const data = parseResult(result);
    expect(data.count).toBe(0);
    expect(data.conflicts).toEqual([]);
  });
});

describe('MCP isolation — share/unshare', () => {
  it('share_atom copies atom to shared namespace', async () => {
    const alphaDir = path.join(testDir, 'agents', 'alpha');
    openIndex(alphaDir);

    const atom = createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'shareable',
      body: 'This should be shared.',
    });

    const ctx = isoCtx('alpha');
    const result = await handleShareAtom(ctx, {
      atom_id: atom.frontmatter.id,
      from_agent: 'alpha',
    });
    const data = parseResult(result);

    expect(data.atom_id).toBe(atom.frontmatter.id);
    expect(data.source_agent).toBe('alpha');
    expect(data.shared_path).toContain('shared');
    expect(fs.existsSync(data.shared_path)).toBe(true);
  });

  it('unshare_atom removes from shared namespace', async () => {
    const alphaDir = path.join(testDir, 'agents', 'alpha');
    openIndex(alphaDir);

    const atom = createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'to-unshare',
      body: 'Will be unshared.',
    });

    const ctx = isoCtx('alpha');
    // Share first
    await handleShareAtom(ctx, { atom_id: atom.frontmatter.id, from_agent: 'alpha' });
    // Then unshare
    const result = await handleUnshareAtom(ctx, { atom_id: atom.frontmatter.id });
    const data = parseResult(result);

    expect(data.atom_id).toBe(atom.frontmatter.id);
    expect(data.removed).toBe(true);
  });

  it('share_atom with mismatched from_agent reads from specified agent store', async () => {
    // Beta tries to share alpha's atom by passing from_agent: 'alpha'
    const alphaDir = path.join(testDir, 'agents', 'alpha');
    openIndex(alphaDir);

    const atom = createAtom({
      memoryDir: alphaDir,
      agent_id: 'alpha',
      session_id: 'test',
      type: 'fact',
      slug: 'alpha-private',
      body: 'Alpha private data.',
    });

    // Beta's context, but passing from_agent: 'alpha' — accesses alpha's store
    const ctxB = isoCtx('beta');
    const result = await handleShareAtom(ctxB, {
      atom_id: atom.frontmatter.id,
      from_agent: 'alpha',
    });
    // This succeeds because from_agent is not cross-checked against ctx.defaultAgentId.
    // Document this as a known design choice: no agent-identity enforcement at tool level.
    const data = parseResult(result);
    expect(data.source_agent).toBe('alpha');
  });

  it('share_atom fails in shared mode', async () => {
    const ctx: McpContext = {
      memoryDir: testDir,
      defaultAgentId: 'test',
      defaultSessionId: 'test',
      isolated: false,
    };
    const result = await handleShareAtom(ctx, { atom_id: 'FACT-xxx', from_agent: 'test' });
    expectError(result, 'isolated');
  });

  it('unshare_atom fails in shared mode', async () => {
    const ctx: McpContext = {
      memoryDir: testDir,
      defaultAgentId: 'test',
      defaultSessionId: 'test',
      isolated: false,
    };
    const result = await handleUnshareAtom(ctx, { atom_id: 'FACT-xxx' });
    expectError(result, 'isolated');
  });
});
