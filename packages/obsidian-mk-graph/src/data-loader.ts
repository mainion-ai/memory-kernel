import { promises as fsp, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseAtomFile, type ParsedAtom } from './atom-parser.js';

const ENTITIES_DIR = 'ENTITIES';
const AGENTS_DIR = 'agents';

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Mirror of mk-core's assertValidAgentId allowlist — rejects any agent ID
 *  that contains characters mk-core would refuse to materialize as a directory.
 *  Without alignment, the plugin would silently route reads to the shared
 *  base dir for IDs the user thinks are valid. */
function isSafeAgentId(agentId: string): boolean {
  return agentId.length > 0 && AGENT_ID_PATTERN.test(agentId);
}

/**
 * Resolve the effective memory dir for a given agent. Mirrors mk-core's
 * resolveAgentDir(): agents/<id>/ if it exists, else the base dir. Empty
 * or path-traversal-shaped agentId falls back to base. Never throws.
 */
export function resolveMemoryDir(baseDir: string, agentId?: string): string {
  if (!agentId || !isSafeAgentId(agentId)) return baseDir;
  const agentDir = path.join(baseDir, AGENTS_DIR, agentId);
  return existsSync(agentDir) ? agentDir : baseDir;
}

/** Read all atom .md files from <memoryDir>/ENTITIES/. Skips dotfiles,
 *  non-.md files, and files that fail to parse. */
export async function readVault(memoryDir: string): Promise<ParsedAtom[]> {
  const entitiesDir = path.join(memoryDir, ENTITIES_DIR);
  if (!existsSync(entitiesDir)) return [];

  let names: string[];
  try {
    names = await fsp.readdir(entitiesDir);
  } catch {
    return [];
  }

  const atoms: ParsedAtom[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!name.endsWith('.md')) continue;
    const file = path.join(entitiesDir, name);
    let content: string;
    try {
      content = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const atom = parseAtomFile(content, file);
    if (atom) atoms.push(atom);
  }
  return atoms;
}

export interface Watcher {
  close(): void;
}

/**
 * Watch the memory dir for atom file mutations. Coalesces rapid changes
 * (~150ms) so a flurry of writes during seeding only triggers one reload.
 * Watches ENTITIES/ subdirectory non-recursively. Caller-provided `onChange`
 * is invoked on the trailing edge of the debounce window.
 */
export function watchVault(memoryDir: string, onChange: () => void): Watcher {
  const entitiesDir = path.join(memoryDir, ENTITIES_DIR);
  if (!existsSync(entitiesDir)) {
    return { close: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(entitiesDir, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 150);
    });
    watcher.on('error', (err) => {
      console.warn('mk-graph: vault watcher error, atom updates may not reflect file changes', err);
    });
  } catch {
    return { close: () => {} };
  }

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    },
  };
}

export { watchEvents } from './events-loader.js';
export { readEvents } from './events-loader.js';
