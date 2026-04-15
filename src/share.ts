/**
 * Share/unshare operations for per-agent isolation.
 *
 * shareAtom: copies an atom snapshot from an agent's store to the shared namespace.
 * unshareAtom: removes an atom from the shared namespace.
 *
 * Shared atoms are snapshots — they do not track updates to the original.
 * Re-sharing overwrites the previous shared version.
 */

import fs from 'fs';
import path from 'path';
import { readAtom, writeAtom, listAtomFiles, assertWithinDir } from './store.js';
import { indexAtom, removeFromIndex, indexExists } from './index-db.js';
import { appendEvent } from './event-log.js';
import { getSharedDir, resolveAgentDir, initSharedStore, isIsolated } from './isolation.js';
import type { Atom } from './types.js';

export interface ShareResult {
  atom_id: string;
  shared_path: string;
  source_agent: string;
}

export interface ShareOptions {
  agent_id: string;
  session_id: string;
}

/**
 * Share an atom from an agent's store to the shared namespace.
 * Copies (snapshots) the atom — does not create a symlink or track updates.
 * Re-sharing the same atom overwrites the previous shared copy.
 *
 * @param baseDir - Root memory directory
 * @param atomId - Atom ID to share
 * @param fromAgent - Agent ID that owns the atom
 * @param opts - Operation options (agent_id, session_id for event logging)
 */
export function shareAtom(
  baseDir: string,
  atomId: string,
  fromAgent: string,
  opts: ShareOptions,
): ShareResult {
  // Share only makes sense in per-agent isolation mode
  if (!isIsolated(baseDir)) {
    throw new Error('shareAtom requires per-agent isolation mode');
  }
  const agentDir = resolveAgentDir(baseDir, fromAgent);
  const sharedDir = getSharedDir(baseDir);

  // Ensure shared store exists
  if (!fs.existsSync(sharedDir)) {
    initSharedStore(baseDir);
  }

  // Find the atom in the agent's store
  const atomFile = findAtomInDir(agentDir, atomId);
  if (!atomFile) {
    throw new Error(`Atom not found in agent "${fromAgent}" store: ${atomId}`);
  }

  // Read the atom
  const atom = readAtom(atomFile);

  // Write snapshot to shared ENTITIES/
  const sharedPath = path.join(sharedDir, 'ENTITIES', `${atomId}.md`);
  assertWithinDir(sharedDir, sharedPath);
  writeAtom(atom, sharedPath);

  // Index in shared store if index exists
  if (indexExists(sharedDir)) {
    atom.filePath = sharedPath;
    indexAtom(sharedDir, atom);
  }

  // Emit event in agent's log
  appendEvent(agentDir, 'atom_updated', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [atomId],
    meta: { action: 'shared', shared_to: 'shared', source_agent: fromAgent },
  });

  return {
    atom_id: atomId,
    shared_path: sharedPath,
    source_agent: fromAgent,
  };
}

/**
 * Remove an atom from the shared namespace.
 *
 * @param baseDir - Root memory directory
 * @param atomId - Atom ID to unshare
 * @param opts - Operation options (agent_id, session_id for event logging)
 */
export function unshareAtom(
  baseDir: string,
  atomId: string,
  opts: ShareOptions,
): void {
  if (!isIsolated(baseDir)) {
    throw new Error('unshareAtom requires per-agent isolation mode');
  }
  const sharedDir = getSharedDir(baseDir);

  if (!fs.existsSync(sharedDir)) {
    throw new Error('Shared namespace does not exist');
  }

  // Find the atom in shared
  const atomFile = findAtomInDir(sharedDir, atomId);
  if (!atomFile) {
    throw new Error(`Atom not found in shared namespace: ${atomId}`);
  }

  assertWithinDir(sharedDir, atomFile);

  // Remove from index
  if (indexExists(sharedDir)) {
    removeFromIndex(sharedDir, atomId);
  }

  // Delete the file
  fs.unlinkSync(atomFile);

  // Emit event in shared log
  appendEvent(sharedDir, 'atom_archived', {
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    atom_refs: [atomId],
    meta: { action: 'unshared' },
  });
}

/**
 * List all atoms in the shared namespace.
 */
export function listSharedAtoms(baseDir: string): Atom[] {
  const sharedDir = getSharedDir(baseDir);
  if (!fs.existsSync(sharedDir)) return [];

  const files = listAtomFiles(sharedDir);
  const atoms: Atom[] = [];
  for (const fp of files) {
    try {
      atoms.push(readAtom(fp));
    } catch {
      // Skip corrupted files
    }
  }
  return atoms;
}

/**
 * Find an atom file by ID in a directory (ENTITIES/ + CONFLICTS/).
 */
function findAtomInDir(dir: string, atomId: string): string | null {
  const files = listAtomFiles(dir);
  for (const fp of files) {
    try {
      const atom = readAtom(fp);
      if (atom.frontmatter.id === atomId) return fp;
    } catch {
      continue;
    }
  }
  return null;
}
