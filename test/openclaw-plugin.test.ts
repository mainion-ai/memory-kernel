/**
 * OpenClaw plugin integration tests.
 *
 * Tests the plugin against a real temp memory directory using actual mk SDK calls.
 * The OpenClaw API object is mocked since we can't run the gateway in tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  indexStats,
  closeAllIndexes,
} from '../src/index.js';

// Import the plugin — it's the default export
import plugin from '../packages/openclaw-memory-kernel/src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ocplugin-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const BASE_OPTS = { agent_id: 'test', session_id: 'test-session' };

// ── Mock OpenClaw API ────────────────────────────────────────────────────────

type ToolHandler = { name: string; execute: (id: any, params: any) => Promise<any> };
type HookHandler = { events: string[]; handler: (event: any) => Promise<void> };

function createMockApi(memoryDir: string) {
  const tools: Record<string, ToolHandler> = {};
  const hooks: HookHandler[] = [];

  const api = {
    pluginConfig: { memoryDir },
    registerTool(def: any, opts: { name: string }) {
      tools[opts.name] = { name: opts.name, execute: def.execute };
    },
    registerHook(events: string[], handler: (event: any) => Promise<void>) {
      hooks.push({ events, handler });
    },
  };

  return { api, tools, hooks };
}

function findHook(hooks: HookHandler[], event: string): HookHandler | undefined {
  return hooks.find((h) => h.events.includes(event));
}

// ── Plugin metadata ──────────────────────────────────────────────────────────

describe('plugin metadata', () => {
  it('has correct id, name, and kind', () => {
    expect(plugin.id).toBe('memory-kernel');
    expect(plugin.kind).toBe('tool');
    expect(plugin.name).toContain('memory-kernel');
  });
});

// ── mk_remember ──────────────────────────────────────────────────────────────

describe('mk_remember', () => {
  it('creates atom with correct frontmatter', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    const result = await tools['mk_remember'].execute('call-1', {
      type: 'fact',
      slug: 'test-fact',
      body: 'TypeScript is a typed language',
      confidence: 0.9,
    });

    expect(result.content[0].text).toContain('Stored fact atom:');
    expect(result.content[0].text).toContain('FACT-');
    expect(result.details.type).toBe('fact');
    expect(result.details.atomId).toMatch(/^FACT-\d{4}-\d{2}-\d{2}-TEST-FACT/);

    // Verify file was actually created
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].frontmatter.type).toBe('fact');
    expect(atoms[0].frontmatter.confidence).toBe(0.9);
    expect(atoms[0].body).toContain('TypeScript is a typed language');
  });

  it('maps scope_tags to scope.tags', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    await tools['mk_remember'].execute('call-1', {
      type: 'decision',
      slug: 'use-vitest',
      body: 'We use vitest for testing',
      scope_tags: ['project:mk', 'topic:testing'],
    });

    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].frontmatter.scope?.tags).toEqual(['project:mk', 'topic:testing']);
  });

  it('handles errors gracefully', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    // Missing required 'body' field — createAtom should throw
    const result = await tools['mk_remember'].execute('call-1', {
      type: 'fact',
      slug: 'bad',
      // body intentionally missing
    });

    expect(result.content[0].text).toContain('Error:');
  });
});

// ── mk_recall ────────────────────────────────────────────────────────────────

describe('mk_recall', () => {
  it('returns structured results with frontmatter fields', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    // Seed some atoms
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'use-ts', body: 'Use TypeScript for all modules' });
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'constraint', slug: 'max-lines', body: 'Max 200 lines per file' });

    const result = await tools['mk_recall'].execute('call-1', {
      task: 'coding standards',
      max_tokens: 4000,
    });

    const text = result.content[0].text;
    // Atom IDs use abbreviated prefixes: DECI-, CONS-
    expect(text).toContain('DECI-');
    expect(text).toContain('CONS-');
    expect(text).toContain('conf:');
    expect(result.details.atomCount).toBe(2);
  });

  it('returns empty result on fresh memory', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    const result = await tools['mk_recall'].execute('call-1', {});
    // recall() always returns index + constraints views even with no atoms
    expect(result.content[0].text).toContain('Memory Index');
    expect(result.details.atomCount).toBe(0);
  });
});

// ── mk_reflect ───────────────────────────────────────────────────────────────

describe('mk_reflect', () => {
  it('runs synchronously and returns counts', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    const result = await tools['mk_reflect'].execute('call-1', {});

    expect(result.content[0].text).toContain('reflect complete');
    expect(result.content[0].text).toContain('expired:');
    expect(result.content[0].text).toContain('deduped:');
    expect(result.content[0].text).toContain('promoted:');
    expect(result.content[0].text).toContain('conflicts:');
  });
});

// ── mk_context_bundle ────────────────────────────────────────────────────────

describe('mk_context_bundle', () => {
  it('returns markdown with atom count and token estimate', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'test', body: 'Test fact' });

    const result = await tools['mk_context_bundle'].execute('call-1', {});

    expect(result.content[0].text).toBeTruthy();
    expect(result.details.atomCount).toBeGreaterThanOrEqual(1);
    expect(result.details.tokenEstimate).toBeGreaterThan(0);
  });
});

// ── mk_status ────────────────────────────────────────────────────────────────

describe('mk_status', () => {
  it('shows atom counts and type breakdown', async () => {
    const { api, tools } = createMockApi(testDir);
    plugin.register(api);

    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'f1', body: 'Fact one' });
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'decision', slug: 'd1', body: 'Decision one' });

    const result = await tools['mk_status'].execute('call-1', {});
    const text = result.content[0].text;

    expect(text).toContain('Atoms: 2');
    expect(text).toContain('"fact":1');
    expect(text).toContain('"decision":1');
  });

  it('handles null indexStats gracefully (no index)', async () => {
    // Create a fresh dir with no index
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-noindex-'));
    initMemoryDir(emptyDir);

    const { api, tools } = createMockApi(emptyDir);
    // Register will try reindex, which is fine on empty dir
    plugin.register(api);

    const result = await tools['mk_status'].execute('call-1', {});
    const text = result.content[0].text;

    expect(text).toContain('Atoms: 0');
    // After reindex on empty dir, stats might be 0 or show "no index"
    // Either is acceptable — the key is it doesn't crash
    expect(text).not.toContain('Error:');

    closeAllIndexes();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ── Lifecycle: bootstrap hook ────────────────────────────────────────────────

describe('bootstrap hook', () => {
  it('injects recall context into bootstrapFiles', async () => {
    const { api, hooks } = createMockApi(testDir);
    plugin.register(api);

    // Seed atoms so recall returns something
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'constraint', slug: 'no-eval', body: 'Never use eval()' });

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    expect(bootstrapHook).toBeDefined();

    const event = { context: { bootstrapFiles: [] as any[] } };
    await bootstrapHook!.handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles[0].path).toBe('memory-kernel-context.md');
    expect(event.context.bootstrapFiles[0].content).toContain('Memory Kernel Context');
    expect(event.context.bootstrapFiles[0].content).toContain('NO-EVAL');
  });

  it('skips injection when no atoms exist', async () => {
    const { api, hooks } = createMockApi(testDir);
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    const event = { context: { bootstrapFiles: [] as any[] } };
    await bootstrapHook!.handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(0);
  });
});

// ── Lifecycle: pre-compaction hook ───────────────────────────────────────────

describe('pre-compaction hook', () => {
  it('creates checkpoint event', async () => {
    const { api, hooks } = createMockApi(testDir);
    plugin.register(api);

    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'pre-compact', body: 'Before compaction' });

    const compactHook = findHook(hooks, 'session:compact:before');
    expect(compactHook).toBeDefined();

    const event = { sessionKey: 'session-123' };
    await compactHook!.handler(event);

    // Verify checkpoint was written by checking events.ndjson
    const eventsPath = path.join(testDir, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const checkpointEvents = events
      .map((l) => JSON.parse(l))
      .filter((e: any) => e.action === 'checkpoint_created');
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Lifecycle: session end hook ──────────────────────────────────────────────

describe('session end hook (command:new)', () => {
  it('runs reflect and writes episode', async () => {
    const { api, hooks } = createMockApi(testDir);
    plugin.register(api);

    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'session-fact', body: 'A fact from this session' });

    const sessionEndHook = findHook(hooks, 'command:new');
    expect(sessionEndHook).toBeDefined();

    const event = {
      sessionKey: 'session-456',
      action: 'new',
      context: { sessionEntry: { id: 'session-456' } },
      messages: [] as string[],
    };

    await sessionEndHook!.handler(event);

    // Verify reflect message was pushed
    expect(event.messages).toContain('mk: reflect complete');

    // Verify episode was written
    const episodesDir = path.join(testDir, 'EPISODES');
    expect(fs.existsSync(episodesDir)).toBe(true);
    const episodeFiles = fs.readdirSync(episodesDir);
    expect(episodeFiles.length).toBeGreaterThanOrEqual(1);

    // Verify episode content
    const episodeContent = fs.readFileSync(path.join(episodesDir, episodeFiles[0]), 'utf-8');
    expect(episodeContent).toContain('Session ended via /new command');
  });

  it('skips episode when no sessionEntry', async () => {
    const { api, hooks } = createMockApi(testDir);
    plugin.register(api);

    const sessionEndHook = findHook(hooks, 'command:new');

    const event = {
      sessionKey: 'session-789',
      action: 'new',
      context: {},
      messages: [] as string[],
    };

    await sessionEndHook!.handler(event);

    // Reflect still runs
    expect(event.messages).toContain('mk: reflect complete');

    // But no episode written
    const episodesDir = path.join(testDir, 'EPISODES');
    if (fs.existsSync(episodesDir)) {
      const files = fs.readdirSync(episodesDir);
      expect(files).toHaveLength(0);
    }
  });
});

// ── Plugin init: reindex ─────────────────────────────────────────────────────

describe('plugin init', () => {
  it('reindexes when no index exists', () => {
    // Create atoms without an index
    createAtom({ memoryDir: testDir, ...BASE_OPTS, type: 'fact', slug: 'reindex-test', body: 'Should be indexed' });
    closeAllIndexes();

    // Delete the index file if it was auto-created
    const indexPath = path.join(testDir, '.memory-index.db');
    if (fs.existsSync(indexPath)) {
      fs.unlinkSync(indexPath);
    }

    expect(indexStats(testDir)).toBeNull();

    const { api } = createMockApi(testDir);
    plugin.register(api);

    // After registration, index should exist
    const stats = indexStats(testDir);
    expect(stats).not.toBeNull();
    expect(stats!.atoms).toBeGreaterThanOrEqual(1);
  });
});
