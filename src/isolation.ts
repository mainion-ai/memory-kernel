/**
 * Per-agent memory isolation.
 *
 * In shared mode (default), resolveAgentDir() is an identity function —
 * all operations use the base memoryDir unchanged.
 *
 * In isolated mode, each agent gets its own store directory under
 * `baseDir/agents/{agentId}/` with its own atoms, index, and events.
 * An optional `baseDir/shared/` namespace holds explicitly shared atoms.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { initMemoryDir, assertWithinDir } from './store.js';
import { ATOM_TYPES } from './types.js';
import type { AtomType, IsolationConfig, RenderConfig } from './types.js';

/** Valid agent ID pattern: alphanumeric, dash, underscore only. */
const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that an agent ID is safe for use as a directory name.
 * Rejects path separators, traversal sequences, and non-alphanumeric characters.
 * This is the single source of truth for agent ID validation across all entry points.
 */
export function assertValidAgentId(agentId: string): void {
  if (!agentId || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(
      `Invalid agent ID "${agentId}": must be non-empty and contain only alphanumeric characters, dashes, or underscores`,
    );
  }
}

/** Default isolation config (shared mode, backward compatible). */
export const DEFAULT_ISOLATION_CONFIG: IsolationConfig = {
  isolation: 'shared',
};

/** Default per-agent render config. */
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  mode: 'balanced',
  max_tokens: 8000,
  include_shared: true,
  type_weights: {},
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Load isolation config from `config.yaml` in the base directory.
 * Falls back to `MK_ISOLATION` env var, then to shared mode default.
 */
export function loadConfig(baseDir: string): IsolationConfig {
  const configPath = path.join(baseDir, 'config.yaml');

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (parsed && typeof parsed === 'object' && 'isolation' in parsed) {
      const mode = parsed.isolation;
      if (mode === 'per-agent' || mode === 'shared') {
        return { isolation: mode };
      }
    }
  }

  // Env var override
  const envMode = process.env['MK_ISOLATION'];
  if (envMode === 'per-agent' || envMode === 'shared') {
    return { isolation: envMode };
  }

  return { ...DEFAULT_ISOLATION_CONFIG };
}

/**
 * Write isolation config to `config.yaml`.
 */
export function writeConfig(baseDir: string, config: IsolationConfig): void {
  const configPath = path.join(baseDir, 'config.yaml');
  fs.mkdirSync(baseDir, { recursive: true });
  const content = yaml.dump(config, { sortKeys: false, lineWidth: -1 });
  fs.writeFileSync(configPath, content);
}

/**
 * Check whether the given base directory is in isolated (per-agent) mode.
 */
export function isIsolated(baseDir: string): boolean {
  return loadConfig(baseDir).isolation === 'per-agent';
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the memory directory for a given agent.
 *
 * - Shared mode (or no agentId): returns baseDir unchanged.
 * - Isolated mode: returns `baseDir/agents/{agentId}/`.
 *
 * @param config - Optional pre-loaded config to avoid redundant disk reads on hot paths.
 */
export function resolveAgentDir(baseDir: string, agentId?: string, config?: IsolationConfig): string {
  if (!agentId) return baseDir;

  const cfg = config ?? loadConfig(baseDir);
  if (cfg.isolation === 'shared') return baseDir;

  assertValidAgentId(agentId);

  const agentDir = path.join(baseDir, 'agents', agentId);
  assertWithinDir(baseDir, agentDir);
  return agentDir;
}

/**
 * Get the shared namespace directory.
 */
export function getSharedDir(baseDir: string): string {
  return path.join(baseDir, 'shared');
}

/**
 * List all agent IDs that have stores in the base directory.
 * Returns an empty array in shared mode or if no agents directory exists.
 */
export function listAgents(baseDir: string): string[] {
  const agentsDir = path.join(baseDir, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && AGENT_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Store initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a per-agent store directory.
 * Creates the standard memory layout (ENTITIES, events.ndjson, etc.)
 * plus a default render.yaml.
 */
export function initAgentStore(baseDir: string, agentId: string): string {
  assertValidAgentId(agentId);
  const agentDir = path.join(baseDir, 'agents', agentId);
  assertWithinDir(baseDir, agentDir);
  initMemoryDir(agentDir);
  // Write default render.yaml if it doesn't exist
  const renderPath = path.join(agentDir, 'render.yaml');
  if (!fs.existsSync(renderPath)) {
    writeRenderConfig(agentDir, { ...DEFAULT_RENDER_CONFIG });
  }
  return agentDir;
}

/**
 * Initialize the shared namespace store.
 */
export function initSharedStore(baseDir: string): string {
  const sharedDir = getSharedDir(baseDir);
  initMemoryDir(sharedDir);
  return sharedDir;
}

/**
 * Initialize a full isolated-mode base directory.
 * Creates config.yaml, shared store, and optionally an initial agent store.
 */
export function initIsolatedBase(baseDir: string, initialAgent?: string): void {
  fs.mkdirSync(baseDir, { recursive: true });
  writeConfig(baseDir, { isolation: 'per-agent' });
  initSharedStore(baseDir);
  if (initialAgent) {
    initAgentStore(baseDir, initialAgent);
  }
}

// ---------------------------------------------------------------------------
// Render config
// ---------------------------------------------------------------------------

const VALID_ATOM_TYPES = new Set<string>(ATOM_TYPES);

/** Validate type_weights: keep only entries where key is a valid AtomType and value is a finite number. */
function validateTypeWeights(raw: Record<string, unknown>): Partial<Record<AtomType, number>> {
  const result: Partial<Record<AtomType, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (VALID_ATOM_TYPES.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      result[key as AtomType] = value;
    }
  }
  return result;
}

/**
 * Load per-agent render config from `render.yaml` in the agent directory.
 * Falls back to defaults for missing fields.
 */
export function loadRenderConfig(agentDir: string): RenderConfig {
  const configPath = path.join(agentDir, 'render.yaml');
  const defaults = { ...DEFAULT_RENDER_CONFIG };

  if (!fs.existsSync(configPath)) return defaults;

  let parsed: Record<string, unknown> | null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    parsed = yaml.load(raw) as Record<string, unknown> | null;
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object') return defaults;

  return {
    mode: typeof parsed.mode === 'string' &&
      ['operational', 'constitutive', 'balanced'].includes(parsed.mode)
      ? (parsed.mode as RenderConfig['mode'])
      : defaults.mode,
    max_tokens: typeof parsed.max_tokens === 'number'
      ? parsed.max_tokens
      : defaults.max_tokens,
    include_shared: typeof parsed.include_shared === 'boolean'
      ? parsed.include_shared
      : defaults.include_shared,
    type_weights: parsed.type_weights && typeof parsed.type_weights === 'object' && !Array.isArray(parsed.type_weights)
      ? validateTypeWeights(parsed.type_weights as Record<string, unknown>)
      : defaults.type_weights,
  };
}

/**
 * Write render config to `render.yaml` in the given directory.
 */
export function writeRenderConfig(dir: string, config: RenderConfig): void {
  const configPath = path.join(dir, 'render.yaml');
  fs.mkdirSync(dir, { recursive: true });
  const content = yaml.dump(config, { sortKeys: false, lineWidth: -1 });
  fs.writeFileSync(configPath, content);
}
