/**
 * Timeline — denormalised replay-ready event stream.
 *
 * Wraps the existing event log with three normalisations:
 * 1. Resolves atom_snapshot_hash via the evidence dir (snapshot inline)
 * 2. Decrypts SECRET snapshots when MEMORY_ENCRYPTION_KEY is set
 * 3. Filters by time range
 *
 * Output is a TimelineEvent[] sorted by timestamp ascending.
 * Used by `mk timeline --json` and the obsidian-mk-graph plugin's replay
 * engine — see docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md §4.2
 */

import fs from 'fs';
import path from 'path';
import { readEvidence } from './evidence.js';
import { isEncrypted, decryptAtom, resolveKey } from './crypto.js';
import type { MemoryEvent } from './types.js';

export interface TimelineEvent extends Omit<MemoryEvent, 'atom_snapshot_hash'> {
  /** When true, the original snapshot was SECRET and no decryption key
   *  was available at timeline-read time. atom_snapshot is undefined. */
  redacted?: boolean;
}

export interface TimelineOptions {
  memoryDir: string;
  /** ISO8601 inclusive lower bound (event.timestamp >= from) */
  from?: string;
  /** ISO8601 inclusive upper bound (event.timestamp <= to) */
  to?: string;
}

export interface TimelineResult {
  events: TimelineEvent[];
}

/**
 * Read the event log, resolve hashes, decrypt SECRETs when possible,
 * filter by time range, sort ascending.
 */
export function getTimeline(opts: TimelineOptions): TimelineResult {
  const eventsFile = path.join(opts.memoryDir, 'events.ndjson');
  if (!fs.existsSync(eventsFile)) {
    return { events: [] };
  }

  const evidenceDir = path.join(opts.memoryDir, 'evidence');
  const key = resolveKey(process.env.MEMORY_ENCRYPTION_KEY);

  const raw = fs.readFileSync(eventsFile, 'utf-8').trim();
  if (!raw) return { events: [] };

  const lines = raw.split('\n');
  const out: TimelineEvent[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: MemoryEvent;
    try {
      ev = JSON.parse(line) as MemoryEvent;
    } catch {
      continue;
    }

    if (opts.from && ev.timestamp < opts.from) continue;
    if (opts.to && ev.timestamp > opts.to) continue;

    let snapshot = ev.atom_snapshot;

    // Resolve hash-only snapshots (v1 events with snapshot stored in evidence)
    if (!snapshot && ev.atom_snapshot_hash && fs.existsSync(evidenceDir)) {
      try {
        snapshot = readEvidence(opts.memoryDir, ev.atom_snapshot_hash).toString('utf-8');
      } catch {
        // Evidence not on disk — emit event without snapshot
      }
    }

    let redacted = false;
    if (snapshot && isEncrypted(snapshot)) {
      if (key) {
        try {
          snapshot = decryptAtom(snapshot, key);
        } catch {
          redacted = true;
          snapshot = undefined;
        }
      } else {
        redacted = true;
        snapshot = undefined;
      }
    }

    // Spread the source event, drop atom_snapshot_hash (TimelineEvent is
    // Omit<MemoryEvent, 'atom_snapshot_hash'>), then override atom_snapshot
    // with the resolved/decrypted value and attach redacted when applicable.
    const { atom_snapshot_hash: _hash, ...rest } = ev;
    void _hash;
    const tEvent: TimelineEvent = {
      ...rest,
      atom_snapshot: snapshot,
      ...(redacted ? { redacted: true } : {}),
    };
    out.push(tEvent);
  }

  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { events: out };
}
