/**
 * Tests for per-agent memory isolation: directory resolution, config loading,
 * mode detection, agent store initialization, and render config.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  writeConfig,
  isIsolated,
  resolveAgentDir,
  getSharedDir,
  listAgents,
  initAgentStore,
  initSharedStore,
  initIsolatedBase,
  loadRenderConfig,
  writeRenderConfig,
  DEFAULT_ISOLATION_CONFIG,
  DEFAULT_RENDER_CONFIG,
  closeAllIndexes,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-isolation-'));
});

afterEach(() => {
  closeAllIndexes();
  // Clean up env var if set
  delete process.env['MK_ISOLATION'];
  fs.rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns shared mode by default when no config exists', () => {
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('shared');
  });

  it('reads isolation mode from config.yaml', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('per-agent');
  });

  it('reads shared mode from config.yaml', () => {
    writeConfig(testDir, { isolation: 'shared' });
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('shared');
  });

  it('ignores invalid isolation values in config.yaml', () => {
    fs.writeFileSync(path.join(testDir, 'config.yaml'), 'isolation: invalid\n');
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('shared');
  });

  it('MK_ISOLATION env var overrides absent config.yaml', () => {
    process.env['MK_ISOLATION'] = 'per-agent';
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('per-agent');
  });

  it('config.yaml takes precedence over MK_ISOLATION env var', () => {
    writeConfig(testDir, { isolation: 'shared' });
    process.env['MK_ISOLATION'] = 'per-agent';
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('shared');
  });

  it('ignores invalid MK_ISOLATION env var', () => {
    process.env['MK_ISOLATION'] = 'bogus';
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('shared');
  });
});

// ---------------------------------------------------------------------------
// writeConfig
// ---------------------------------------------------------------------------

describe('writeConfig', () => {
  it('creates config.yaml in base directory', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(fs.existsSync(path.join(testDir, 'config.yaml'))).toBe(true);
    const config = loadConfig(testDir);
    expect(config.isolation).toBe('per-agent');
  });

  it('creates base directory if it does not exist', () => {
    const nested = path.join(testDir, 'deep', 'nested');
    writeConfig(nested, { isolation: 'per-agent' });
    expect(fs.existsSync(path.join(nested, 'config.yaml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isIsolated
// ---------------------------------------------------------------------------

describe('isIsolated', () => {
  it('returns false in shared mode', () => {
    expect(isIsolated(testDir)).toBe(false);
  });

  it('returns true when config says per-agent', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(isIsolated(testDir)).toBe(true);
  });

  it('returns true when MK_ISOLATION=per-agent and no config file', () => {
    process.env['MK_ISOLATION'] = 'per-agent';
    expect(isIsolated(testDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentDir
// ---------------------------------------------------------------------------

describe('resolveAgentDir', () => {
  it('returns baseDir unchanged in shared mode', () => {
    expect(resolveAgentDir(testDir, 'huston')).toBe(testDir);
  });

  it('returns baseDir when no agentId provided', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(resolveAgentDir(testDir)).toBe(testDir);
  });

  it('returns baseDir when agentId is undefined in isolated mode', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(resolveAgentDir(testDir, undefined)).toBe(testDir);
  });

  it('returns agent directory in isolated mode', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    const dir = resolveAgentDir(testDir, 'huston');
    expect(dir).toBe(path.join(testDir, 'agents', 'huston'));
  });

  it('handles different agent IDs', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(resolveAgentDir(testDir, 'main')).toBe(path.join(testDir, 'agents', 'main'));
    expect(resolveAgentDir(testDir, 'gridmaster')).toBe(path.join(testDir, 'agents', 'gridmaster'));
  });

  it('rejects agent IDs containing forward slash', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(() => resolveAgentDir(testDir, 'agent/subdir')).toThrow(/path separators/);
  });

  it('rejects agent IDs containing backslash', () => {
    writeConfig(testDir, { isolation: 'per-agent' });
    expect(() => resolveAgentDir(testDir, 'agent\\subdir')).toThrow(/path separators/);
  });
});

// ---------------------------------------------------------------------------
// getSharedDir
// ---------------------------------------------------------------------------

describe('getSharedDir', () => {
  it('returns shared directory path', () => {
    expect(getSharedDir(testDir)).toBe(path.join(testDir, 'shared'));
  });
});

// ---------------------------------------------------------------------------
// listAgents
// ---------------------------------------------------------------------------

describe('listAgents', () => {
  it('returns empty array when no agents directory', () => {
    expect(listAgents(testDir)).toEqual([]);
  });

  it('returns empty array when agents directory is empty', () => {
    fs.mkdirSync(path.join(testDir, 'agents'), { recursive: true });
    expect(listAgents(testDir)).toEqual([]);
  });

  it('lists agent directories sorted alphabetically', () => {
    initIsolatedBase(testDir);
    initAgentStore(testDir, 'huston');
    initAgentStore(testDir, 'main');
    initAgentStore(testDir, 'gridmaster');
    const agents = listAgents(testDir);
    expect(agents).toEqual(['gridmaster', 'huston', 'main']);
  });

  it('ignores files in agents directory', () => {
    fs.mkdirSync(path.join(testDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'agents', 'not-a-dir.txt'), 'hi');
    initAgentStore(testDir, 'real-agent');
    expect(listAgents(testDir)).toEqual(['real-agent']);
  });
});

// ---------------------------------------------------------------------------
// initAgentStore
// ---------------------------------------------------------------------------

describe('initAgentStore', () => {
  it('creates standard memory layout under agents/{id}/', () => {
    const agentDir = initAgentStore(testDir, 'huston');
    expect(agentDir).toBe(path.join(testDir, 'agents', 'huston'));
    expect(fs.existsSync(path.join(agentDir, 'ENTITIES'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'ARCHIVE'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'CONFLICTS'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'EPISODES'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'EVIDENCE'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'events.ndjson'))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'INDEX.md'))).toBe(true);
  });

  it('creates default render.yaml', () => {
    const agentDir = initAgentStore(testDir, 'huston');
    expect(fs.existsSync(path.join(agentDir, 'render.yaml'))).toBe(true);
  });

  it('does not overwrite existing render.yaml', () => {
    const agentDir = initAgentStore(testDir, 'huston');
    const renderPath = path.join(agentDir, 'render.yaml');
    fs.writeFileSync(renderPath, 'mode: operational\n');
    // Re-init
    initAgentStore(testDir, 'huston');
    const content = fs.readFileSync(renderPath, 'utf-8');
    expect(content).toBe('mode: operational\n');
  });

  it('is idempotent', () => {
    initAgentStore(testDir, 'huston');
    initAgentStore(testDir, 'huston');
    expect(fs.existsSync(path.join(testDir, 'agents', 'huston', 'ENTITIES'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initSharedStore
// ---------------------------------------------------------------------------

describe('initSharedStore', () => {
  it('creates standard memory layout under shared/', () => {
    const sharedDir = initSharedStore(testDir);
    expect(sharedDir).toBe(path.join(testDir, 'shared'));
    expect(fs.existsSync(path.join(sharedDir, 'ENTITIES'))).toBe(true);
    expect(fs.existsSync(path.join(sharedDir, 'events.ndjson'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// initIsolatedBase
// ---------------------------------------------------------------------------

describe('initIsolatedBase', () => {
  it('creates config.yaml with per-agent isolation', () => {
    initIsolatedBase(testDir);
    expect(isIsolated(testDir)).toBe(true);
  });

  it('creates shared namespace', () => {
    initIsolatedBase(testDir);
    expect(fs.existsSync(path.join(testDir, 'shared', 'ENTITIES'))).toBe(true);
  });

  it('creates initial agent store if provided', () => {
    initIsolatedBase(testDir, 'main');
    expect(fs.existsSync(path.join(testDir, 'agents', 'main', 'ENTITIES'))).toBe(true);
    expect(listAgents(testDir)).toEqual(['main']);
  });

  it('works without initial agent', () => {
    initIsolatedBase(testDir);
    expect(listAgents(testDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Render config
// ---------------------------------------------------------------------------

describe('loadRenderConfig', () => {
  it('returns defaults when no render.yaml exists', () => {
    const config = loadRenderConfig(testDir);
    expect(config.mode).toBe('balanced');
    expect(config.max_tokens).toBe(8000);
    expect(config.include_shared).toBe(true);
    expect(config.type_weights).toEqual({});
  });

  it('reads render.yaml from directory', () => {
    writeRenderConfig(testDir, {
      mode: 'operational',
      max_tokens: 6000,
      include_shared: false,
      type_weights: { fact: 1.0, belief: 0.3 },
    });
    const config = loadRenderConfig(testDir);
    expect(config.mode).toBe('operational');
    expect(config.max_tokens).toBe(6000);
    expect(config.include_shared).toBe(false);
    expect(config.type_weights).toEqual({ fact: 1.0, belief: 0.3 });
  });

  it('falls back to defaults for missing fields', () => {
    fs.writeFileSync(path.join(testDir, 'render.yaml'), 'mode: constitutive\n');
    const config = loadRenderConfig(testDir);
    expect(config.mode).toBe('constitutive');
    expect(config.max_tokens).toBe(8000); // default
    expect(config.include_shared).toBe(true); // default
  });

  it('handles invalid mode gracefully', () => {
    fs.writeFileSync(path.join(testDir, 'render.yaml'), 'mode: invalid\n');
    const config = loadRenderConfig(testDir);
    expect(config.mode).toBe('balanced'); // falls back to default
  });

  it('handles empty render.yaml', () => {
    fs.writeFileSync(path.join(testDir, 'render.yaml'), '');
    const config = loadRenderConfig(testDir);
    expect(config.mode).toBe('balanced');
  });

  it('handles malformed YAML gracefully', () => {
    fs.writeFileSync(path.join(testDir, 'render.yaml'), '{{{{not yaml');
    // js-yaml throws on invalid YAML — loadRenderConfig should handle this
    // Since our implementation doesn't try-catch, let's check what happens
    // Actually the js-yaml.load will throw. We should handle this.
    expect(() => loadRenderConfig(testDir)).not.toThrow();
  });
});

describe('writeRenderConfig', () => {
  it('writes render.yaml that can be read back', () => {
    const config = {
      mode: 'operational' as const,
      max_tokens: 5000,
      include_shared: true,
      type_weights: { decision: 0.8, belief: 1.0 },
    };
    writeRenderConfig(testDir, config);
    const loaded = loadRenderConfig(testDir);
    expect(loaded).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Integration: full isolated setup
// ---------------------------------------------------------------------------

describe('full isolated setup', () => {
  it('creates complete isolated directory layout', () => {
    initIsolatedBase(testDir, 'main');
    initAgentStore(testDir, 'huston');
    initAgentStore(testDir, 'gridmaster');

    // Config
    expect(isIsolated(testDir)).toBe(true);

    // Agents
    expect(listAgents(testDir)).toEqual(['gridmaster', 'huston', 'main']);

    // Each agent has standard layout
    for (const agent of ['main', 'huston', 'gridmaster']) {
      const dir = path.join(testDir, 'agents', agent);
      expect(fs.existsSync(path.join(dir, 'ENTITIES'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'events.ndjson'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'render.yaml'))).toBe(true);
    }

    // Shared namespace
    expect(fs.existsSync(path.join(testDir, 'shared', 'ENTITIES'))).toBe(true);
  });

  it('resolveAgentDir routes to correct directories', () => {
    initIsolatedBase(testDir, 'main');
    expect(resolveAgentDir(testDir, 'main')).toBe(path.join(testDir, 'agents', 'main'));
    expect(resolveAgentDir(testDir, 'huston')).toBe(path.join(testDir, 'agents', 'huston'));
    expect(resolveAgentDir(testDir)).toBe(testDir); // no agent → base
  });
});
