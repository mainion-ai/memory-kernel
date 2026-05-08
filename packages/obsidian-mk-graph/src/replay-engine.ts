import { parseAtomFile, type ParsedAtom } from './atom-parser.js';
import { isMutationEvent, type PluginEvent } from './event-parser.js';

export interface ReplayOptions {
  /** Stop processing events whose timestamp is strictly greater than this
   *  ISO8601 string. When omitted, replays the entire stream. */
  targetTimestamp?: string;
  /** Atoms read from disk. Used as a fallback for V1 events that lack a
   *  snapshot — replay can't reconstruct historical state but can at least
   *  show the atom in its current form. Keyed by atom id. */
  fallbackAtoms?: ParsedAtom[];
}

/**
 * Pure replay: events → atom map at time T (or "now" if no target).
 * Deterministic: same inputs → identical output.
 *
 * Algorithm:
 *  1. Filter to mutation events with timestamp ≤ targetTimestamp.
 *  2. Sort by timestamp ascending (file order is *usually* chronological
 *     but mk-core makes no hard guarantee, and merged event logs interleave).
 *  3. Walk events:
 *     - atom_created / atom_updated / atom_promoted with snapshot →
 *       parse via parseAtomFile, set in map (overwrites).
 *     - atom_created / atom_updated / atom_promoted without snapshot →
 *       try fallbackAtoms[atomId]; skip silently if not found (V1 limitation).
 *     - atom_archived / atom_expired → delete from map.
 *
 * V1 events without snapshots can't reconstruct historical content; we use
 * the current atom file as a best-effort proxy. Mismatch with historical
 * state is documented in CHANGELOG and the smoke checklist.
 */
export function replayEvents(
  events: PluginEvent[],
  opts: ReplayOptions = {},
): Map<string, ParsedAtom> {
  const fallbackById = new Map<string, ParsedAtom>();
  if (opts.fallbackAtoms) {
    for (const a of opts.fallbackAtoms) fallbackById.set(a.id, a);
  }

  const filtered = events.filter((ev) => {
    if (!isMutationEvent(ev)) return false;
    if (opts.targetTimestamp && ev.timestamp > opts.targetTimestamp) return false;
    return true;
  });
  filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const out = new Map<string, ParsedAtom>();

  for (const ev of filtered) {
    const ids = ev.atom_refs ?? [];
    if (ev.action === 'atom_archived' || ev.action === 'atom_expired') {
      for (const id of ids) out.delete(id);
      continue;
    }

    // Created / updated / promoted — need a snapshot.
    if (ev.atom_snapshot) {
      const atom = parseAtomFile(ev.atom_snapshot);
      if (atom) {
        // Inherit filePath from the current on-disk fallback by id so that
        // click-to-open works in Scrubbed / Diff modes — `parseAtomFile` only
        // sets filePath when given an explicit path, and we don't have the
        // path inside event snapshots. Atoms that no longer exist on disk
        // (e.g. archived after the playhead) gracefully stay un-clickable.
        const fb = fallbackById.get(atom.id);
        if (fb?.filePath) atom.filePath = fb.filePath;
        out.set(atom.id, atom);
        continue;
      }
      // Snapshot present but unparseable — fall through to fallback.
    }

    // V1 path or unparseable snapshot — try the on-disk fallback.
    for (const id of ids) {
      const fb = fallbackById.get(id);
      if (fb) out.set(id, fb);
    }
  }

  return out;
}
