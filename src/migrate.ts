/**
 * Migration tooling for converting a shared-mode memory store
 * to per-agent isolated mode.
 *
 * Three strategies:
 * - fresh:          Write config, create shared dir, leave existing atoms as-is
 * - partition:      Route atoms to agent subdirs by their creating agent_id
 * - clone-to-shared: Copy all existing atoms into the shared namespace
 */

import fs from 'fs';
import path from 'path';
import {
  writeConfig,
  initAgentStore,
  initSharedStore,
  isIsolated,
  assertValidAgentId,
} from './isolation.js';
import { listAtoms, readAtom, writeAtom } from './store.js';
import { readEvents } from './event-log.js';
import { reindex } from './index-db.js';
import type { Atom } from './types.js';

/** Check if an agent ID is valid without throwing. */
function isValidAgentId(id: string): boolean {
  try {
    assertValidAgentId(id);
    return true;
  } catch {
    return false;
  }
}

export type MigrateStrategy = 'fresh' | 'partition' | 'clone-to-shared';

export interface MigrateOptions {
  baseDir: string;
  strategy: MigrateStrategy;
  /** Agent ID to assign atoms with unknown/missing agent_id (partition strategy). */
  assignUntagged?: string;
}

export interface MigrateResult {
  strategy: MigrateStrategy;
  agents_created: string[];
  atoms_moved: number;
  atoms_shared: number;
  config_written: boolean;
  backup_path: string;
}

/**
 * Migrate a shared-mode store to per-agent isolation.
 * Fails if the store is already in isolated mode.
 */
export function migrate(opts: MigrateOptions): MigrateResult {
  const { baseDir, strategy } = opts;

  if (isIsolated(baseDir)) {
    throw new Error('Store is already in isolated (per-agent) mode');
  }

  switch (strategy) {
    case 'fresh':
      return migrateFresh(opts);
    case 'partition':
      return migratePartition(opts);
    case 'clone-to-shared':
      return migrateCloneToShared(opts);
    default:
      throw new Error(`Unknown migration strategy: ${strategy}`);
  }
}

// ---------------------------------------------------------------------------
// Backup helper
// ---------------------------------------------------------------------------

/**
 * Create a timestamped backup of all atom files before destructive migration.
 * Returns the backup directory path, or '' if no atoms to back up.
 */
function createMigrationBackup(baseDir: string, atoms: Atom[]): string {
  if (atoms.length === 0) return '';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(baseDir, `.mk-backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const atom of atoms) {
    if (!atom.filePath) continue;
    const relPath = path.relative(baseDir, atom.filePath);
    const destPath = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(atom.filePath, destPath);
  }

  return backupDir;
}

// ---------------------------------------------------------------------------
// Strategy: fresh
// ---------------------------------------------------------------------------

function migrateFresh(opts: MigrateOptions): MigrateResult {
  const { baseDir } = opts;

  writeConfig(baseDir, { isolation: 'per-agent' });
  initSharedStore(baseDir);

  return {
    strategy: 'fresh',
    agents_created: [],
    atoms_moved: 0,
    atoms_shared: 0,
    config_written: true,
    backup_path: '',
  };
}

// ---------------------------------------------------------------------------
// Strategy: partition
// ---------------------------------------------------------------------------

function migratePartition(opts: MigrateOptions): MigrateResult {
  const { baseDir, assignUntagged = 'main' } = opts;

  if (!isValidAgentId(assignUntagged)) {
    throw new Error(`Invalid assignUntagged agent ID: ${assignUntagged}`);
  }

  // 1. Scan events for distinct agent_ids
  const events = readEvents(baseDir);
  const atomAgentMap = new Map<string, string>();
  for (const event of events) {
    if (event.atom_refs) {
      for (const ref of event.atom_refs) {
        // First event wins — that's the creating agent
        if (!atomAgentMap.has(ref)) {
          const rawId = event.agent_id;
          // Reject agent IDs that would create nested dirs under agents/
          atomAgentMap.set(ref, isValidAgentId(rawId) ? rawId : assignUntagged);
        }
      }
    }
  }

  // 2. Load all atoms and create backup before any destructive operations
  const atoms = listAtoms(baseDir);
  const backupPath = createMigrationBackup(baseDir, atoms);

  // 3. Group atoms by agent
  const agentAtoms = new Map<string, Atom[]>();
  for (const atom of atoms) {
    const agentId = atomAgentMap.get(atom.frontmatter.id) ?? assignUntagged;
    if (!agentAtoms.has(agentId)) {
      agentAtoms.set(agentId, []);
    }
    agentAtoms.get(agentId)!.push(atom);
  }

  // 4. Write config FIRST so a crash leaves the store in "already isolated" state
  //    (idempotent on re-run) rather than a zombie with deleted atoms but shared config
  writeConfig(baseDir, { isolation: 'per-agent' });

  // 5. Create shared namespace
  initSharedStore(baseDir);

  // 6. Create agent dirs and move atoms
  const agentsCreated: string[] = [];
  let atomsMoved = 0;

  for (const [agentId, agentAtomList] of agentAtoms) {
    const agentDir = initAgentStore(baseDir, agentId);
    agentsCreated.push(agentId);

    for (const atom of agentAtomList) {
      const subDir = atom.frontmatter.type === 'conflict' ? 'CONFLICTS' : 'ENTITIES';
      const destPath = path.join(agentDir, subDir, path.basename(atom.filePath!));
      writeAtom(atom, destPath);
      // Remove original to prevent stale atoms if isolation config is later removed
      try {
        fs.unlinkSync(atom.filePath!);
      } catch {
        // Source already removed or inaccessible — destination was written atomically, so proceed
      }
      atomsMoved++;
    }

    // 7. Rebuild index
    reindex(agentDir);
  }

  // 8. Rebuild base index (now empty of atoms)
  reindex(baseDir);

  return {
    strategy: 'partition',
    agents_created: agentsCreated.sort(),
    atoms_moved: atomsMoved,
    atoms_shared: 0,
    config_written: true,
    backup_path: backupPath,
  };
}

// ---------------------------------------------------------------------------
// Strategy: clone-to-shared
// ---------------------------------------------------------------------------

function migrateCloneToShared(opts: MigrateOptions): MigrateResult {
  const { baseDir } = opts;

  // 1. Create shared namespace
  const sharedDir = initSharedStore(baseDir);

  // 2. Copy all existing atoms to shared (backup first)
  const atoms = listAtoms(baseDir);
  const backupPath = createMigrationBackup(baseDir, atoms);

  // 3. Write config FIRST so a crash leaves the store in "already isolated" state
  writeConfig(baseDir, { isolation: 'per-agent' });

  let atomsShared = 0;

  for (const atom of atoms) {
    const subDir = atom.frontmatter.type === 'conflict' ? 'CONFLICTS' : 'ENTITIES';
    const destPath = path.join(sharedDir, subDir, path.basename(atom.filePath!));
    writeAtom(atom, destPath);
    // Remove original to prevent stale atoms if isolation config is later removed
    try {
      fs.unlinkSync(atom.filePath!);
    } catch {
      // Source already removed or inaccessible — destination was written, so proceed
    }
    atomsShared++;
  }

  // 4. Rebuild shared index
  reindex(sharedDir);

  // 5. Rebuild base index (now empty of atoms)
  reindex(baseDir);

  return {
    strategy: 'clone-to-shared',
    agents_created: [],
    atoms_moved: 0,
    atoms_shared: atomsShared,
    config_written: true,
    backup_path: backupPath,
  };
}
