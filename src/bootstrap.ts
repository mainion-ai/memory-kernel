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
 * Idempotent-ish: if run twice, it will create duplicate imports.
 * The backup lets you recover.
 */
export function bootstrapEvents(opts: {
  memoryDir: string;
  agent_id: string;
  session_id: string;
}): BootstrapResult {
  const { memoryDir, agent_id, session_id } = opts;

  // 1. Read all atoms from disk
  const atoms = listAtoms(memoryDir);

  // 2. Generate atom_imported events
  const importEvents: MemoryEvent[] = atoms.map((atom) =>
    makeImportEvent(atom, agent_id, session_id),
  );

  // Sort by timestamp (preserves atom creation order)
  importEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // 3. Read existing events
  const existingEvents = readEvents(memoryDir);

  // 4. Backup original events.ndjson
  const logPath = path.join(memoryDir, 'events.ndjson');
  const backupPath = logPath + '.bak';

  if (fs.existsSync(logPath)) {
    fs.copyFileSync(logPath, backupPath);
  }

  // 5. Write: import events + existing events
  const allEvents = [...importEvents, ...existingEvents];
  const ndjson = allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileAtomic(logPath, ndjson);

  return {
    imported: importEvents.length,
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
