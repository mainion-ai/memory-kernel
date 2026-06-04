/**
 * Append-only NDJSON event log.
 * Source of truth for "what happened." Views are derived from this.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import lockfile from 'proper-lockfile';
import { validateEvent, generateEventId, isMutationAction } from './schema.js';
import { normalizeTimestamp } from './format.js';
import { writeFileAtomic } from './store.js';
import type { CompactResult, EventAction, MemoryEvent } from './types.js';

/**
 * Acquire an exclusive advisory lock on events.ndjson for the duration of a
 * read-modify-write cycle. Returns a `release` function; callers MUST invoke
 * it in `finally`.
 *
 * Why this exists (#98): `compactLog` does a read-filter-merge-write cycle.
 * Without serialisation against `appendEvent`, any append that lands between
 * compactLog's re-read and `writeFileAtomic`'s `renameSync` is silently lost
 * because the rename clobbers the post-append on-disk file with stale data.
 * Locking both call sites — not just `compactLog` — is load-bearing: a lock
 * inside `compactLog` alone would only serialise compactions against each
 * other.
 *
 * `proper-lockfile`'s sync API does NOT support retries (the underlying
 * `retry` library is async-only). We implement a small synchronous retry
 * loop with bounded backoff so concurrent writers wait rather than fail —
 * events must persist durably under contention.
 *
 * The lockfile is a sibling: `${logPath}.lock`. It is created/removed via
 * atomic `mkdir`/`rmdir` and is independent of the 0o600 perms on
 * events.ndjson itself.
 */
function acquireEventsLock(logPath: string): () => void {
  // 50 attempts × 20ms ≈ 1s of contention tolerance per caller, well below
  // proper-lockfile's 10s stale threshold.
  const MAX_ATTEMPTS = 50;
  const RETRY_MS = 20;
  // The file must exist for lockSync (default realpath: true). Defensive
  // create — initMemoryDir already creates it at 0o600, but a fresh dir
  // without init shouldn't crash here on the first append.
  if (!fs.existsSync(logPath)) {
    writeFileAtomic(logPath, '', 0o600);
  }
  let lastErr: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return lockfile.lockSync(logPath, { stale: 10_000, realpath: false });
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code !== 'ELOCKED') {
        // Surface non-contention errors immediately (e.g. EACCES, ENOENT).
        throw err;
      }
      // Busy-wait between retries. Atomicwait is fine here — appendEvent
      // and compactLog are already synchronous, and the wait window is
      // bounded.
      const buf = new SharedArrayBuffer(4);
      const view = new Int32Array(buf);
      Atomics.wait(view, 0, 0, RETRY_MS);
    }
  }
  throw lastErr ?? new Error(`Failed to acquire lock on ${logPath} after ${MAX_ATTEMPTS} attempts`);
}

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
    // V2 fields
    schema_version?: 2;
    atom_snapshot?: string;
    atom_snapshot_hash?: string;
  },
): MemoryEvent {
  // #111: branch on the schema_version discriminant so the constructed
  //       event narrows cleanly to MemoryEventV1 or MemoryEventV2.
  const base = {
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
  const event: MemoryEvent =
    opts.schema_version === 2
      ? {
          ...base,
          schema_version: 2,
          atom_snapshot: opts.atom_snapshot,
          atom_snapshot_hash: opts.atom_snapshot_hash,
        }
      : { ...base };

  // Validate before writing
  const result = validateEvent(event);
  if (!result.success) {
    throw new Error(`Invalid event: ${JSON.stringify(result.error.issues)}`);
  }

  // Append to NDJSON (with fsync for durability).
  // Hold an exclusive lock around the append so compactLog's read-modify-write
  // cycle cannot overlap and silently clobber this event. See #98.
  const logPath = path.join(memoryDir, 'events.ndjson');
  const line = JSON.stringify(event) + '\n';
  const release = acquireEventsLock(logPath);
  try {
    const fd = fs.openSync(logPath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Re-assert owner-only perms in case the file pre-existed at the platform
    // default (e.g. store created before PR-12). chmod is a no-op on Windows
    // and best-effort on POSIX — same wrapping pattern as writeAtom for
    // SECRET files in store.ts. See #138.
    try { fs.chmodSync(logPath, 0o600); } catch { /* best-effort */ }
  } finally {
    try { release(); } catch { /* best-effort: lock auto-expires via stale ttl */ }
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

  return content.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as MemoryEvent];
    } catch {
      return []; // Skip corrupted lines
    }
  });
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
 * Compact the event log by keeping only the latest mutation event per atom
 * and all non-mutation events. Creates a timestamped backup before writing.
 *
 * This reduces log size for large stores where many atoms have been updated
 * multiple times. The compacted log is still sufficient for replay — only
 * intermediate snapshots are discarded.
 */
export function compactLog(memoryDir: string): CompactResult {
  const logPath = path.join(memoryDir, 'events.ndjson');

  // Acquire an exclusive lock around the entire read-modify-write cycle.
  // Without this, concurrent appendEvent calls between our re-read and the
  // rename inside writeFileAtomic are silently lost when the rename clobbers
  // the post-append on-disk file. See #98.
  const release = acquireEventsLock(logPath);
  try {
    const events = readEvents(memoryDir);
    const eventsBefore = events.length;

    if (eventsBefore === 0) {
      return { events_before: 0, events_after: 0, removed: 0, backup_path: '' };
    }

    // For each atom, keep only the LATEST mutation event.
    // Non-mutation events (reflect_completed, session_started, etc.) are always kept.
    // atom_imported events are kept when they are the latest for that atom.
    const latestMutationByAtom = new Map<string, number>(); // atom_id → event index

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (!isMutationAction(evt.action)) continue;
      if (!evt.atom_refs) continue;
      for (const ref of evt.atom_refs) {
        latestMutationByAtom.set(ref, i);
      }
    }

    // Build the set of event indices to keep
    const keepIndices = new Set<number>();
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (!isMutationAction(evt.action)) {
        // Non-mutation: always keep
        keepIndices.add(i);
      } else if (evt.atom_refs) {
        // Mutation: keep only if this is the latest mutation for ANY of its atom refs
        for (const ref of evt.atom_refs) {
          if (latestMutationByAtom.get(ref) === i) {
            keepIndices.add(i);
            break;
          }
        }
      } else {
        // Mutation with no atom_refs: keep (shouldn't happen, but safe)
        keepIndices.add(i);
      }
    }

    const compacted = events.filter((_, i) => keepIndices.has(i));
    const eventsAfter = compacted.length;
    const removed = eventsBefore - eventsAfter;

    if (removed === 0) {
      return { events_before: eventsBefore, events_after: eventsAfter, removed: 0, backup_path: '' };
    }

    // Create timestamped backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = logPath + `.bak.${timestamp}`;
    if (fs.existsSync(logPath)) {
      fs.copyFileSync(logPath, backupPath);
    }

    // Re-read inside the lock to capture any events appended between the
    // first read (above) and the lock acquisition. (Pre-#98 this re-read
    // existed without a lock and was the half-fix that the race exploited;
    // now it is itself protected against further appends until release.)
    const latestEvents = readEvents(memoryDir);
    const originalIds = new Set(events.map((e) => e.event_id));
    const newEvents = latestEvents.filter((e) => !originalIds.has(e.event_id));
    const finalCompacted = [...compacted, ...newEvents];

    // @internal Test-only hook: spawn a child process appendEvent and give
    // it a head start to block on the lock before we proceed to the rename.
    // We then sleep briefly so the lock-contention window is observable.
    // Used by test/event-log-compact-race.test.ts to prove the lost-write
    // race is closed. The hook is `bin arg1 arg2 ...` (space-separated);
    // we append memoryDir as the final argument. Never invoked unless the
    // env var is set.
    const hookCmd = process.env.MK_COMPACT_LOG_TEST_HOOK_PATH;
    if (hookCmd) {
      const [bin, ...args] = hookCmd.split(' ');
      const child = spawn(bin, [...args, memoryDir], {
        stdio: 'inherit',
        detached: false,
      });
      child.unref();
      // Sleep long enough for the child to attempt the lock-grab and start
      // its retry loop. With the lock held by this process, the child must
      // wait — proving that the in-process re-read above didn't see its
      // append, but the lock-protected append-after-release does.
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 250);
    }

    // Write compacted log at 0o600 — atomic rename preserves the mode set
    // via writeFileAtomic, so we don't lose owner-only perms on compact. See #138.
    const ndjson = finalCompacted.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileAtomic(logPath, ndjson, 0o600);

    return { events_before: eventsBefore, events_after: finalCompacted.length, removed: eventsBefore - finalCompacted.length, backup_path: backupPath };
  } finally {
    try { release(); } catch { /* best-effort: lock auto-expires via stale ttl */ }
  }
}

/**
 * Count events in the log.
 * Matches readEvents() semantics: skips blank lines AND unparseable JSON lines.
 * This ensures countEvents() === readEvents().length for any log state.
 */
export function countEvents(memoryDir: string): number {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return 0;

  const content = fs.readFileSync(logPath, 'utf-8').trim();
  if (!content) return 0;

  let count = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      count++;
    } catch {
      // Skip malformed lines — same as readEvents()
    }
  }
  return count;
}

/**
 * Read the event_id of the last event in the log.
 * Efficient: reads only the tail of the file rather than parsing all events.
 */
export function getLastEventId(memoryDir: string): string | undefined {
  const logPath = path.join(memoryDir, 'events.ndjson');
  if (!fs.existsSync(logPath)) return undefined;

  const content = fs.readFileSync(logPath, 'utf-8').trimEnd();
  if (!content) return undefined;

  // Read from end to find the last non-empty line
  const lastNewline = content.lastIndexOf('\n');
  const lastLine = lastNewline === -1 ? content : content.slice(lastNewline + 1);

  try {
    const event = JSON.parse(lastLine) as MemoryEvent;
    return event.event_id;
  } catch {
    return undefined;
  }
}
