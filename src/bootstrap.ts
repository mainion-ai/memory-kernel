/**
 * Bootstrap/migration — converts existing atom files into V2 events.
 * Creates `atom_imported` events with full snapshots so the event log
 * becomes a complete system-of-record that can reconstruct all state via replay.
 */

import fs from 'fs';
import path from 'path';
import { listAtoms } from './store.js';
import { serializeAtom } from './format.js';
import { readEvents } from './event-log.js';
import { generateEventId } from './schema.js';
import { normalizeTimestamp } from './format.js';
import { writeFileAtomic } from './store.js';
import type { Atom, MemoryEvent, BootstrapResult } from './types.js';

/**
 * Generate atom_imported events for all existing atoms and prepend them
 * to the event log. Backs up the original events.ndjson first.
 *
 * Idempotent: if an atom_imported event already exists for an atom ID,
 * that atom is skipped. Backup uses timestamped filenames to prevent
 * overwriting previous backups.
 */
export function bootstrapEvents(opts: {
  memoryDir: string;
  agent_id: string;
  session_id: string;
}): BootstrapResult {
  const { memoryDir, agent_id, session_id } = opts;

  // 1. Read all atoms from disk
  const atoms = listAtoms(memoryDir);

  // 2. Read existing events and collect already-imported atom IDs
  const existingEvents = readEvents(memoryDir);
  const alreadyImported = new Set<string>();
  for (const evt of existingEvents) {
    if (evt.action === 'atom_imported' && evt.atom_refs) {
      for (const ref of evt.atom_refs) {
        alreadyImported.add(ref);
      }
    }
  }

  // 3. Generate atom_imported events, skipping already-imported atoms
  let skipped = 0;
  const importEvents: MemoryEvent[] = [];
  for (const atom of atoms) {
    if (alreadyImported.has(atom.frontmatter.id)) {
      skipped++;
      continue;
    }
    importEvents.push(makeImportEvent(atom, agent_id, session_id));
  }

  // Sort by timestamp (preserves atom creation order)
  importEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 4. Backup original events.ndjson with timestamped name
  const logPath = path.join(memoryDir, 'events.ndjson');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = logPath + `.bak.${timestamp}`;

  if (fs.existsSync(logPath)) {
    fs.copyFileSync(logPath, backupPath);
  }

  // 5. Write: import events + existing events (skip if no new imports)
  const allEvents = [...importEvents, ...existingEvents];
  if (importEvents.length > 0) {
    const ndjson = allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileAtomic(logPath, ndjson);
  }

  return {
    imported: importEvents.length,
    skipped,
    events_written: allEvents.length,
    backup_path: backupPath,
  };
}

/**
 * Create a synthetic atom_imported event for an existing atom.
 */
function makeImportEvent(
  atom: Atom,
  agent_id: string,
  session_id: string,
): MemoryEvent {
  return {
    event_id: generateEventId(),
    timestamp: normalizeTimestamp(atom.frontmatter.created_at),
    agent_id,
    session_id,
    action: 'atom_imported',
    atom_refs: [atom.frontmatter.id],
    schema_version: 2,
    atom_snapshot: serializeAtom(atom),
    meta: { bootstrap: true },
  };
}
