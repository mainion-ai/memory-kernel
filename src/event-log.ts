/**
 * Append-only NDJSON event log.
 * Source of truth for "what happened." Views are derived from this.
 */

import fs from 'fs';
import path from 'path';
import { validateEvent, generateEventId } from './schema.js';
import { normalizeTimestamp } from './format.js';
import type { EventAction, MemoryEvent } from './types.js';

/**
 * Append an event to the log. Returns the event with generated ID.
 */
export function appendEvent(
  memoryDir: string,
  action: EventAction,
  opts: {
    agent_id: string;
    session_id: string;
    atom_refs?: string[];
    touched_paths?: string[];
    evidence?: string[];
    meta?: Record<string, unknown>;
  },
): MemoryEvent {
  const event: MemoryEvent = {
    event_id: generateEventId(),
    timestamp: normalizeTimestamp(),
    agent_id: opts.agent_id,
    session_id: opts.session_id,
    action,
    atom_refs: opts.atom_refs,
    touched_paths: opts.touched_paths,
    evidence: opts.evidence,
    meta: opts.meta,
  };

  // Validate before writing
  const result = validateEvent(event);
  if (!result.success) {
    throw new Error(`Invalid event: ${JSON.stringify(result.error.issues)}`);
  }

  // Append to NDJSON (with fsync for durability)
  const logPath = path.join(memoryDir, 'events.ndjson');
  const line = JSON.stringify(event) + '\n';
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return event;
}

/**
 * Read all events from the log.
 */
export function readEvents(memoryDir: string): MemoryEvent[] {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return [];

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  if (!content) return [];

  return content.split('\n').map((line) => JSON.parse(line) as MemoryEvent);
}

/**
 * Read events filtered by action type.
 */
export function readEventsByAction(
  memoryDir: string,
  action: EventAction,
): MemoryEvent[] {
  return readEvents(memoryDir).filter((e) => e.action === action);
}

/**
 * Read events related to specific atom IDs.
 */
export function readEventsForAtoms(
  memoryDir: string,
  atomIds: string[],
): MemoryEvent[] {
  const idSet = new Set(atomIds);
  return readEvents(memoryDir).filter(
    (e) => e.atom_refs?.some((ref) => idSet.has(ref)),
  );
}

/**
 * Count events in the log.
 */
export function countEvents(memoryDir: string): number {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return 0;

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  if (!content) return 0;

  return content.split('\n').length;
}
