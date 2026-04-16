/**
 * OpenClaw plugin per-agent isolation tests.
 *
 * Tests the plugin's isolation routing against real temp memory directories
 * using actual mk SDK calls. The OpenClaw API is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  closeAllIndexes,
  initIsolatedBase,
  initAgentStore,
} from '../src/index.js';

import plugin from '../packages/openclaw-memory-kernel/src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ociso-'));
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const BASE_OPTS = { agent_id: 'test', session_id: 'test-session' };

// ── Mock OpenClaw API ────────────────────────────────────────────────────────

type ToolHandler = { name: string; execute: (id: any, params: any) => Promise<any> };
type HookHandler = { events: string[]; handler: (event: any) => Promise<void> };

function createMockApi(config: Record<string, unknown>) {
  const tools: Record<string, ToolHandler> = {};
  const hooks: HookHandler[] = [];

  const api = {
    pluginConfig: config,
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

// ── Config parsing ──────────────────────────────────────────────────────────

describe('isolation config parsing', () => {
  it('defaults to auto isolation mode in shared mode with no config.yaml', () => {
    initMemoryDir(testDir);
    const { api, tools } = createMockApi({ memoryDir: testDir });
    plugin.register(api);

    // Should work — shared mode, flat memoryDir
    expect(tools['mk_status']).toBeDefined();
  });

  it('detects per-agent mode when config.yaml says so (auto mode)', () => {
    initIsolatedBase(testDir, 'main');
    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'main' });
    plugin.register(api);

    // Should work — isolated mode, routes to agents/main/
    expect(tools['mk_status']).toBeDefined();
  });

  it('shared-only ignores per-agent config.yaml', () => {
    initIsolatedBase(testDir, 'main');
    const { api, tools } = createMockApi({
      memoryDir: testDir,
      agentId: 'main',
      isolationMode: 'shared-only',
    });
    plugin.register(api);

    // Should succeed — forced shared mode
    expect(tools['mk_recall']).toBeDefined();
  });

  it('per-agent-required throws when config.yaml says shared', () => {
    initMemoryDir(testDir); // shared mode

    // Debug: verify the config parsing works
    const parsed = plugin.configSchema.parse({
      memoryDir: testDir,
      agentId: 'main',
      isolationMode: 'per-agent-required',
    });
    expect(parsed.isolationMode).toBe('per-agent-required');

    // Now test that register throws
    expect(() =>
      plugin.register(
        createMockApi({
          memoryDir: testDir,
          agentId: 'main',
          isolationMode: 'per-agent-required',
        }).api,
      ),
    ).toThrow(/per-agent-required/);
  });

  it('per-agent-required throws when memoryDir does not exist', () => {
    const noDir = path.join(testDir, 'nonexistent');
    expect(() =>
      plugin.register(
        createMockApi({
          memoryDir: noDir,
          isolationMode: 'per-agent-required',
        }).api,
      ),
    ).toThrow(/per-agent-required.*does not exist/);
  });
});

// ── Effective memory context ────────────────────────────────────────────────

describe('effective memory context resolution', () => {
  it('shared mode: effectiveDir is baseDir', async () => {
    initMemoryDir(testDir);
    const { api, tools } = createMockApi({ memoryDir: testDir });
    plugin.register(api);

    // mk_status output should reference the base dir directly
    const result = await tools['mk_status'].execute('call-1', {});
    expect(result.content[0].text).toContain(testDir);
    expect(result.content[0].text).toContain('Isolation: shared');
  });

  it('isolated mode: effectiveDir is agents/{id}/', async () => {
    initIsolatedBase(testDir, 'huston');
    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_status'].execute('call-1', {});
    expect(result.content[0].text).toContain(path.join(testDir, 'agents', 'huston'));
    expect(result.content[0].text).toContain('Isolation: per-agent (agent: huston)');
  });

  it('missing agent store without autoInit throws with actionable message', () => {
    initIsolatedBase(testDir); // no agent store created
    expect(() =>
      plugin.register(
        createMockApi({ memoryDir: testDir, agentId: 'huston' }).api,
      ),
    ).toThrow(/agent store for "huston" does not exist.*mk init -a huston/);
  });

  it('missing agent store with autoInitAgentStore=true creates store', () => {
    initIsolatedBase(testDir); // config.yaml + shared/ but no agent store
    const { api } = createMockApi({
      memoryDir: testDir,
      agentId: 'huston',
      autoInitAgentStore: true,
    });
    plugin.register(api);

    // Store should now exist
    expect(fs.existsSync(path.join(testDir, 'agents', 'huston'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'agents', 'huston', 'ENTITIES'))).toBe(true);
  });

  it('agentId defaults to openclaw when not configured', async () => {
    initIsolatedBase(testDir, 'openclaw');
    const { api, tools } = createMockApi({ memoryDir: testDir });
    plugin.register(api);

    const result = await tools['mk_status'].execute('call-1', {});
    expect(result.content[0].text).toContain('agent: openclaw');
  });

  it('allowSharedFallback: true restores old fallback behavior', async () => {
    initIsolatedBase(testDir); // no agent store created
    const { api, tools } = createMockApi({
      memoryDir: testDir,
      agentId: 'huston',
      allowSharedFallback: true,
    });
    plugin.register(api); // should NOT throw

    const result = await tools['mk_status'].execute('call-1', {});
    expect(result.content[0].text).toContain('Isolation: shared');
  });

  it('failIfMissingAgentStore: false maps to allowSharedFallback for backward compat', () => {
    initIsolatedBase(testDir); // no agent store created
    const { api } = createMockApi({
      memoryDir: testDir,
      agentId: 'huston',
      failIfMissingAgentStore: false,
    });
    // Should NOT throw — legacy failIfMissingAgentStore: false implies allowSharedFallback
    expect(() => plugin.register(api)).not.toThrow();
  });
});

// ── Tool routing in isolated mode ───────────────────────────────────────────

describe('tool routing in isolated mode', () => {
  it('mk_remember writes to agent store, not base dir', async () => {
    initIsolatedBase(testDir, 'huston');
    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    await tools['mk_remember'].execute('call-1', {
      type: 'fact',
      slug: 'huston-fact',
      body: 'Huston specific memory',
    });

    // Atom should be in agents/huston/ENTITIES, not testDir/ENTITIES
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const hustonAtoms = listAtoms(hustonDir);
    expect(hustonAtoms).toHaveLength(1);
    expect(hustonAtoms[0].body).toContain('Huston specific memory');

    // Base dir should NOT have atoms (no ENTITIES dir at base in isolated mode)
    const baseEntities = path.join(testDir, 'ENTITIES');
    if (fs.existsSync(baseEntities)) {
      const baseAtoms = fs.readdirSync(baseEntities);
      expect(baseAtoms).toHaveLength(0);
    }
  });

  it('mk_recall returns union of agent + shared atoms', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const sharedDir = path.join(testDir, 'shared');

    // Create atoms in agent store
    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'agent-fact', body: 'Agent-private fact',
    });

    // Create atoms in shared store
    createAtom({
      memoryDir: sharedDir, ...BASE_OPTS,
      type: 'decision', slug: 'shared-decision', body: 'Shared decision for all',
    });

    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_recall'].execute('call-1', { max_tokens: 8000 });
    const text = result.content[0].text;

    // Should see both agent and shared atoms
    expect(text).toContain('FACT-');
    expect(text).toContain('DECI-');
    expect(result.details.atomCount).toBe(2);
  });

  it('mk_recall with sharedRecall=false returns agent-only atoms', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'agent-fact', body: 'Agent fact',
    });
    createAtom({
      memoryDir: sharedDir, ...BASE_OPTS,
      type: 'decision', slug: 'shared-dec', body: 'Shared decision',
    });

    const { api, tools } = createMockApi({
      memoryDir: testDir,
      agentId: 'huston',
      sharedRecall: false,
    });
    plugin.register(api);

    const result = await tools['mk_recall'].execute('call-1', { max_tokens: 8000 });

    // Should only see agent atoms, not shared
    expect(result.details.atomCount).toBe(1);
    expect(result.content[0].text).toContain('FACT-');
    expect(result.content[0].text).not.toContain('DECI-');
  });

  it('cross-agent isolation: agent A atoms never appear in agent B recall', async () => {
    initIsolatedBase(testDir, 'main');
    initAgentStore(testDir, 'huston');

    const mainDir = path.join(testDir, 'agents', 'main');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    // Create atoms in main's store
    createAtom({
      memoryDir: mainDir, ...BASE_OPTS,
      type: 'fact', slug: 'main-secret', body: 'Main private fact',
    });

    // Create atoms in huston's store
    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'decision', slug: 'huston-decision', body: 'Huston private decision',
    });

    // Register plugin as huston
    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_recall'].execute('call-1', { max_tokens: 8000 });

    // Should see only huston's atom, NOT main's
    expect(result.details.atomCount).toBe(1);
    expect(result.content[0].text).toContain('DECI-');
    expect(result.content[0].text).not.toContain('Main private fact');
  });

  it('mk_reflect operates on agent store only', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'reflect-test', body: 'Test reflect scoping',
    });

    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_reflect'].execute('call-1', {});
    expect(result.content[0].text).toContain('reflect complete');
  });

  it('mk_context_bundle uses agent store', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'bundle-test', body: 'Bundle test fact',
    });

    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_context_bundle'].execute('call-1', {});
    expect(result.content[0].text).toBeTruthy();
    expect(result.details.atomCount).toBeGreaterThanOrEqual(1);
  });

  it('mk_context_bundle includes shared atoms in isolated mode', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'agent-bundle-fact', body: 'Agent fact for context bundle',
    });
    createAtom({
      memoryDir: sharedDir, ...BASE_OPTS,
      type: 'decision', slug: 'shared-bundle-dec', body: 'Shared decision for context bundle',
    });

    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_context_bundle'].execute('call-1', { max_tokens: 8000 });
    // Should include both agent and shared atoms
    expect(result.details.atomCount).toBe(2);
  });

  it('mk_status reports isolation info', async () => {
    initIsolatedBase(testDir, 'huston');

    const { api, tools } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const result = await tools['mk_status'].execute('call-1', {});
    const text = result.content[0].text;

    expect(text).toContain('Isolation: per-agent (agent: huston)');
    expect(text).toContain('Base dir:');
    expect(text).toContain('Shared namespace: exists');
    expect(text).toContain('Shared recall: enabled');
  });
});

// ── Hook routing in isolated mode ───────────────────────────────────────────

describe('hook routing in isolated mode', () => {
  it('bootstrap injects union recall (agent + shared)', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'constraint', slug: 'no-eval', body: 'Never use eval()',
    });
    createAtom({
      memoryDir: sharedDir, ...BASE_OPTS,
      type: 'fact', slug: 'shared-fact', body: 'Shared knowledge',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    expect(bootstrapHook).toBeDefined();

    const event = {
      context: { bootstrapFiles: [] as any[] },
      messages: [] as string[],
    };
    await bootstrapHook!.handler(event);

    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles[0].content).toContain('NO-EVAL');
    expect(event.context.bootstrapFiles[0].content).toContain('SHARED-FACT');
    expect(event.messages[0]).toContain('bootstrap agent=huston isolated=true');
  });

  it('bootstrap does not include other agents private atoms', async () => {
    initIsolatedBase(testDir, 'main');
    initAgentStore(testDir, 'huston');

    const mainDir = path.join(testDir, 'agents', 'main');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: mainDir, ...BASE_OPTS,
      type: 'fact', slug: 'main-only', body: 'Main private knowledge',
    });
    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'huston-only', body: 'Huston private knowledge',
    });

    // Register as huston
    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    const event = {
      context: { bootstrapFiles: [] as any[] },
      messages: [] as string[],
    };
    await bootstrapHook!.handler(event);

    // Should have huston's atom but NOT main's
    const content = event.context.bootstrapFiles[0]?.content ?? '';
    expect(content).toContain('HUSTON-ONLY');
    expect(content).not.toContain('Main private knowledge');
  });

  it('pre-compaction checkpoint routes to agent store', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'compact-test', body: 'Pre-compaction test',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const compactHook = findHook(hooks, 'session:compact:before');
    expect(compactHook).toBeDefined();

    const event = { sessionKey: 'session-123', messages: [] as string[] };
    await compactHook!.handler(event);

    // Checkpoint event should be in huston's events log
    const eventsPath = path.join(hustonDir, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const checkpointEvents = events
      .map((l) => JSON.parse(l))
      .filter((e: any) => e.action === 'checkpoint_created');
    expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('session-end reflect + episode go to agent store', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'session-fact', body: 'Session fact for huston',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const sessionEndHook = findHook(hooks, 'command:new');
    expect(sessionEndHook).toBeDefined();

    const event = {
      sessionKey: 'session-456',
      action: 'new',
      context: { sessionEntry: { id: 'session-456' } },
      messages: [] as string[],
    };

    await sessionEndHook!.handler(event);

    expect(event.messages).toContain('mk: reflect complete');

    // Episode should be in huston's EPISODES dir
    const episodesDir = path.join(hustonDir, 'EPISODES');
    expect(fs.existsSync(episodesDir)).toBe(true);
    const episodeFiles = fs.readdirSync(episodesDir);
    expect(episodeFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('bootstrap extracts runtime agent identity from event context', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'id-test', body: 'Identity test atom',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    const event = {
      context: {
        bootstrapFiles: [] as any[],
        agentIdentity: { id: 'runtime-huston' },
      },
      messages: [] as string[],
    };
    await bootstrapHook!.handler(event);

    // Bootstrap message should reflect the updated runtime identity
    expect(event.messages[0]).toContain('agent=runtime-huston');
  });

  it('bootstrap uses config agentId when runtime identity is absent', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'no-runtime-id', body: 'No runtime identity',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    const event = {
      context: { bootstrapFiles: [] as any[] },
      messages: [] as string[],
    };
    await bootstrapHook!.handler(event);

    // Should fall back to the configured agentId
    expect(event.messages[0]).toContain('agent=huston');
  });

  it('pre-compaction checkpoint includes shared atoms in isolated mode', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');
    const sharedDir = path.join(testDir, 'shared');

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'agent-precompact', body: 'Agent pre-compact fact',
    });
    createAtom({
      memoryDir: sharedDir, ...BASE_OPTS,
      type: 'constraint', slug: 'shared-precompact', body: 'Shared pre-compact constraint',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const compactHook = findHook(hooks, 'session:compact:before');
    const event = { sessionKey: 'session-789', messages: [] as string[] };
    await compactHook!.handler(event);

    // Checkpoint event should include both agent and shared atoms
    const eventsPath = path.join(hustonDir, 'events.ndjson');
    const events = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const ckptEvent = events
      .map((l) => JSON.parse(l))
      .find((e: any) => e.action === 'checkpoint_created');
    expect(ckptEvent).toBeDefined();
    expect(ckptEvent.meta.atom_count).toBe(2);
    expect(ckptEvent.meta.isolated).toBe(true);
  });

  it('bootstrap with missing shared/ dir does not crash', async () => {
    initIsolatedBase(testDir, 'huston');
    const hustonDir = path.join(testDir, 'agents', 'huston');

    // Remove shared dir
    fs.rmSync(path.join(testDir, 'shared'), { recursive: true, force: true });

    createAtom({
      memoryDir: hustonDir, ...BASE_OPTS,
      type: 'fact', slug: 'solo-fact', body: 'Agent-only fact',
    });

    const { api, hooks } = createMockApi({ memoryDir: testDir, agentId: 'huston' });
    plugin.register(api);

    const bootstrapHook = findHook(hooks, 'agent:bootstrap');
    const event = {
      context: { bootstrapFiles: [] as any[] },
      messages: [] as string[],
    };

    // Should not throw
    await bootstrapHook!.handler(event);
    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles[0].content).toContain('SOLO-FACT');
  });
});

// ── Backward compatibility ──────────────────────────────────────────────────

describe('backward compatibility', () => {
  it('shared mode behavior is identical to existing tests', async () => {
    initMemoryDir(testDir);
    const { api, tools } = createMockApi({ memoryDir: testDir });
    plugin.register(api);

    // Full round-trip in shared mode
    await tools['mk_remember'].execute('call-1', {
      type: 'fact',
      slug: 'compat-test',
      body: 'Backward compatible fact',
    });

    const result = await tools['mk_recall'].execute('call-2', { max_tokens: 4000 });
    expect(result.content[0].text).toContain('FACT-');
    expect(result.details.atomCount).toBe(1);

    // Verify atom is in base dir (not in any agents/ subdir)
    const atoms = listAtoms(testDir);
    expect(atoms).toHaveLength(1);
    expect(atoms[0].body).toContain('Backward compatible fact');
  });

  it('plugin manifest configSchema matches jsonSchema', () => {
    const manifestPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      'packages',
      'openclaw-memory-kernel',
      'openclaw.plugin.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(plugin.configSchema.jsonSchema).toEqual(manifest.configSchema);
  });
});
