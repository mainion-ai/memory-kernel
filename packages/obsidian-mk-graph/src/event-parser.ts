/**
 * One line of `events.ndjson`, validated and narrowed to the fields the
 * plugin uses. Mirrors mk-core's `MemoryEvent` (src/types.ts) but stays
 * decoupled — the plugin must not import mk-core (drags in `better-sqlite3`).
 */
export interface PluginEvent {
  event_id: string;
  timestamp: string;        // ISO8601 — replay sorts by this
  agent_id: string;
  session_id: string;
  action: string;
  atom_refs?: string[];
  /** V2 events only. When present, the full atom .md content at the time
   *  of the event. Replay uses this to reconstruct historical state. */
  atom_snapshot?: string;
  /** V2 events only. SHA-256 of `atom_snapshot` if it lives in `evidence/`.
   *  The plugin doesn't resolve hashes — atom-file fallback covers V1/V2
   *  hash-only cases. Tracked for debugging. */
  atom_snapshot_hash?: string;
  schema_version?: number;
}

const MUTATION_ACTIONS = new Set([
  'atom_created',
  'atom_updated',
  'atom_archived',
  'atom_promoted',
  'atom_expired',
]);

/** Returns true when the event mutates atom state and therefore matters
 *  for replay. Non-mutation events (recall, wander, compact) are filtered
 *  out at parse time. */
export function isMutationEvent(ev: Pick<PluginEvent, 'action'>): boolean {
  return MUTATION_ACTIONS.has(ev.action);
}

/** Parse one NDJSON line into a `PluginEvent`. Returns null on:
 *  - empty / whitespace lines
 *  - JSON parse errors
 *  - missing required fields (event_id, timestamp, action)
 *  Never throws. The events-loader silently skips nulls so a single bad
 *  line can't break replay. */
export function parseEventLine(line: string): PluginEvent | null {
  if (!line.trim()) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;

  const o = raw as Record<string, unknown>;
  if (typeof o.event_id !== 'string' || !o.event_id) return null;
  if (typeof o.timestamp !== 'string' || !o.timestamp) return null;
  if (typeof o.action !== 'string' || !o.action) return null;

  const ev: PluginEvent = {
    event_id: o.event_id,
    timestamp: o.timestamp,
    agent_id: typeof o.agent_id === 'string' ? o.agent_id : '',
    session_id: typeof o.session_id === 'string' ? o.session_id : '',
    action: o.action,
  };
  if (Array.isArray(o.atom_refs)) {
    ev.atom_refs = o.atom_refs.filter((x): x is string => typeof x === 'string');
  }
  if (typeof o.atom_snapshot === 'string') ev.atom_snapshot = o.atom_snapshot;
  if (typeof o.atom_snapshot_hash === 'string') ev.atom_snapshot_hash = o.atom_snapshot_hash;
  if (typeof o.schema_version === 'number') ev.schema_version = o.schema_version;

  return ev;
}
