/**
 * Provenance — the backward path for `human_edit` events (#247).
 *
 * The forward path (`src/edit.ts`) records edits made through `mk edit`. This
 * module detects edits that ALREADY happened off-band — direct filesystem edits
 * that bypassed the event system — and optionally backfills synthetic
 * `human_edit` events for them so the reconciliation pass (#246/#364) can see
 * the strongest disconfirmatory signal.
 *
 * Two detection signals, labelled by confidence:
 *   - `content-diff` (high): the atom's current serialized form differs from the
 *     snapshot in its latest recorded mutation event. Catches field additions
 *     AND value changes. Available for atoms with a V2 snapshot (i.e. created or
 *     last mutated since the event log carried snapshots) and not SECRET (whose
 *     snapshots are encrypted and non-deterministic, so byte-comparison is
 *     meaningless).
 *   - `timestamp-heuristic` (low): the atom's `updated_at` is newer than the
 *     timestamp of its latest mutation event. Catches value changes; misses
 *     field additions where `updated_at` was not bumped. Used when no usable
 *     snapshot is available.
 *
 * Bulk `mk doctor --fix` migration passes also write atoms without events, but
 * they cluster on a single same-second `updated_at` — that signature is
 * detected and EXCLUDED from synthetic backfill (it is migration noise, not a
 * human correction). Only clearly-scattered edits are backfilled.
 *
 * Note: a handful of other mk commands (`relate`, `relink`, `enrich-relations`,
 * `migrate-relations`) also write atoms without emitting events. Those surface
 * as `content-diff` candidates too — which is why synthetic backfill is opt-in
 * (`mk reflect --backfill-human-edits`) and every candidate is labelled by
 * confidence rather than silently emitted on every reflect.
 */

import { appendEvent } from './event-log.js';
import { serializeAtom, parseAtom } from './format.js';
import { snapshotAtom } from './retain.js';
import { isMutationAction } from './schema.js';
import { sha256Hex } from './evidence.js';
import type { Atom, MemoryEvent } from './types.js';

export type DetectionConfidence = 'content-diff' | 'timestamp-heuristic';

export interface UnprovenancedWrite {
  atom_id: string;
  type: string;
  filePath: string;
  confidence: DetectionConfidence;
  /**
   * True when this atom shares its `updated_at` second with at least
   * `CLUSTER_MIN` other candidates — the signature of a bulk `mk doctor --fix`
   * migration pass rather than a hand edit. Clustered candidates are excluded
   * from synthetic backfill.
   */
  cluster: boolean;
  detail: string;
}

/** ≥ this many candidates sharing one `updated_at` second ⇒ migration cluster. */
const CLUSTER_MIN = 3;

/**
 * Normalize a stored snapshot through the CURRENT serializer so historical
 * format drift (key order, relations-section formatting) cancels out and only
 * genuine content differences survive the comparison. Returns null if the
 * snapshot can't be parsed (caller falls back to the timestamp heuristic).
 */
function normalizedSnapshot(snapshot: string): string | null {
  try {
    return serializeAtom(parseAtom(snapshot));
  } catch {
    return null;
  }
}

/**
 * Detect atoms whose on-disk content was changed without a corresponding event.
 *
 * Pure read-only analysis: reads `atoms` + `events`, emits nothing. Archived and
 * expired atoms are skipped (they live in ARCHIVE/ and their terminal mutation
 * is the last word). Atoms with no mutation event at all (predating the event
 * log) are skipped — there is no baseline to attribute an edit against.
 */
export function detectUnprovenancedWrites(
  atoms: Atom[],
  events: MemoryEvent[],
): UnprovenancedWrite[] {
  // Latest mutation event per atom id (snapshot baseline + timestamp baseline).
  const latestMut = new Map<string, MemoryEvent>();
  for (const ev of events) {
    if (!isMutationAction(ev.action) || !ev.atom_refs) continue;
    for (const ref of ev.atom_refs) {
      const prev = latestMut.get(ref);
      // `>=` so a later same-timestamp event (file order) wins.
      if (!prev || ev.timestamp >= prev.timestamp) latestMut.set(ref, ev);
    }
  }

  const candidates: UnprovenancedWrite[] = [];
  const stampById = new Map<string, string>();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!atom.filePath) continue;
    if (fm.status === 'archived' || fm.status === 'expired') continue;

    const latest = latestMut.get(fm.id);
    if (!latest) continue; // predates the event log — no baseline

    const isSecret = fm.classification === 'SECRET';
    const snapshot = latest.atom_snapshot;
    const canContentDiff = !isSecret && typeof snapshot === 'string' && snapshot.length > 0;

    let candidate: UnprovenancedWrite | undefined;

    if (canContentDiff) {
      const base = normalizedSnapshot(snapshot as string);
      if (base !== null) {
        if (sha256Hex(base) !== sha256Hex(serializeAtom(atom))) {
          candidate = {
            atom_id: fm.id,
            type: fm.type,
            filePath: atom.filePath,
            confidence: 'content-diff',
            cluster: false,
            detail: `content differs from last recorded snapshot (event ${latest.event_id})`,
          };
        }
        // Content-diff is authoritative when a parseable snapshot exists —
        // a matching snapshot means the write WAS provenanced; do not also
        // run the weaker timestamp heuristic (which would false-positive on
        // a legit update whose event timestamp rounds below updated_at).
        if (candidate) {
          candidates.push(candidate);
          stampById.set(fm.id, fm.updated_at);
        }
        continue;
      }
      // Unparseable snapshot — fall through to the timestamp heuristic.
    }

    const updatedMs = Date.parse(fm.updated_at);
    const eventMs = Date.parse(latest.timestamp);
    if (Number.isFinite(updatedMs) && Number.isFinite(eventMs) && updatedMs > eventMs) {
      candidate = {
        atom_id: fm.id,
        type: fm.type,
        filePath: atom.filePath,
        confidence: 'timestamp-heuristic',
        cluster: false,
        detail: `updated_at (${fm.updated_at}) is newer than last event (${latest.timestamp})`,
      };
      candidates.push(candidate);
      stampById.set(fm.id, fm.updated_at);
    }
  }

  // Cluster detection: group candidates by their updated_at second. A group of
  // CLUSTER_MIN+ is a bulk migration signature — mark them so backfill skips.
  const byStamp = new Map<string, UnprovenancedWrite[]>();
  for (const c of candidates) {
    const stamp = stampById.get(c.atom_id) as string;
    const arr = byStamp.get(stamp) ?? [];
    arr.push(c);
    byStamp.set(stamp, arr);
  }
  for (const arr of byStamp.values()) {
    if (arr.length >= CLUSTER_MIN) {
      for (const c of arr) c.cluster = true;
    }
  }

  return candidates;
}

export interface BackfillOptions {
  memoryDir: string;
  agent_id: string;
  session_id: string;
}

export interface BackfillResult {
  detected: number;
  backfilled: number;
  clustered_skipped: number;
  by_confidence: Record<DetectionConfidence, number>;
}

/**
 * Detect unprovenanced writes and emit synthetic `human_edit` events for the
 * clearly-scattered ones (clustered migration writes are skipped). Each
 * synthetic event carries the atom's current snapshot and is tagged
 * `meta.synthetic = true` plus its detection confidence — so a reviewer (and the
 * reconciliation pass) can tell a backfilled inference from a live `mk edit`.
 *
 * Idempotent: the emitted event becomes the atom's latest mutation event, so a
 * second pass sees the baseline match (content-diff) or a newer event timestamp
 * (timestamp-heuristic) and re-detects nothing.
 */
export function backfillHumanEdits(
  opts: BackfillOptions,
  atoms: Atom[],
  events: MemoryEvent[],
): BackfillResult {
  const detected = detectUnprovenancedWrites(atoms, events);
  const byId = new Map(atoms.map((a) => [a.frontmatter.id, a]));

  let backfilled = 0;
  let clustered = 0;

  for (const d of detected) {
    if (d.cluster) {
      clustered++;
      continue;
    }
    const atom = byId.get(d.atom_id);
    if (!atom) continue;

    appendEvent(opts.memoryDir, 'human_edit', {
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      atom_refs: [d.atom_id],
      touched_paths: atom.filePath ? [atom.filePath] : undefined,
      evidence: [d.detail],
      meta: {
        synthetic: true,
        source: 'mk reflect --backfill-human-edits',
        detection_confidence: d.confidence,
      },
      schema_version: 2,
      atom_snapshot: snapshotAtom(atom),
    });
    backfilled++;
  }

  return {
    detected: detected.length,
    backfilled,
    clustered_skipped: clustered,
    by_confidence: {
      'content-diff': detected.filter((d) => d.confidence === 'content-diff').length,
      'timestamp-heuristic': detected.filter((d) => d.confidence === 'timestamp-heuristic').length,
    },
  };
}
