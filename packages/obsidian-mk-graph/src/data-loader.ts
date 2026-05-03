import { promises as fsp, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseAtomFile, type ParsedAtom } from './atom-parser.js';

const ENTITIES_DIR = 'ENTITIES';
const AGENTS_DIR = 'agents';

/** Reject agent IDs that contain path separators or `..` segments — these
 *  would let `path.join` escape the `agents/` namespace and route reads
 *  outside the intended store. */
function isSafeAgentId(agentId: string): boolean {
  if (agentId.length === 0) return false;
  if (agentId.includes('/') || agentId.includes('\\')) return false;
  if (agentId === '.' || agentId === '..') return false;
  return true;
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
    // Swallow watcher-level errors (e.g. mid-session directory deletion)
    // so they don't surface as uncaught exceptions in Electron's renderer.
    // Caller can re-init via close() + watchVault() if needed.
    watcher.on('error', () => {});
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
