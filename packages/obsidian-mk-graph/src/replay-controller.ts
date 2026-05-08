import type { ParsedAtom } from './atom-parser.js';
import type { PluginEvent } from './event-parser.js';
import { replayEvents } from './replay-engine.js';
import { diffStates, type DiffSet } from './diff-state.js';
import type { ReplayMode } from './scrubber.js';

export interface ReplayState {
  atoms: ParsedAtom[];
  /** Set only in Diff mode. */
  diff?: DiffSet;
  /** ISO8601 the renderer should display as "as of". For Live mode this
   *  is "now" (the controller fills it with the latest event timestamp,
   *  or `undefined` if there are no events). */
  asOf?: string;
}

export interface ReplayControllerOptions {
  onState: (s: ReplayState) => void;
}

/**
 * Owns the replay-mode state machine. Inputs (events, fallback atoms,
 * mode, playhead, diff range) come from the view; output is a single
 * `ReplayState` emitted via `onState` on every change.
 *
 * Modes:
 *  - `live`: emit fallbackAtoms directly. `replayEvents` is bypassed
 *    because atom files are the live source of truth (and they're cheap
 *    to read; the view already watches them).
 *  - `scrubbed`: emit `replayEvents(events, { targetTimestamp: playhead })`.
 *    Falls back to `fallbackAtoms` for V1 events that lack snapshots.
 *  - `diff`: dual-replay at `t1` and `t2`, compute `diffStates`, emit
 *    the union of both states with the `DiffSet`.
 */
export class ReplayController {
  private events: PluginEvent[] = [];
  private fallback: ParsedAtom[] = [];
  private mode: ReplayMode = 'live';
  private playhead: string | undefined;
  private diffT1: string | undefined;
  private diffT2: string | undefined;

  constructor(private readonly opts: ReplayControllerOptions) {}

  setEvents(events: PluginEvent[]): void { this.events = events; this.emit(); }
  setFallbackAtoms(atoms: ParsedAtom[]): void { this.fallback = atoms; this.emit(); }
  setMode(mode: ReplayMode): void { this.mode = mode; this.emit(); }
  setPlayhead(iso: string): void { this.playhead = iso; this.emit(); }
  setDiffRange(t1: string, t2: string): void { this.diffT1 = t1; this.diffT2 = t2; this.emit(); }

  /** Snapshot the current state without emitting (used by tests). */
  current(): ReplayState { return this.compute(); }

  private emit(): void {
    this.opts.onState(this.compute());
  }

  private compute(): ReplayState {
    if (this.mode === 'live') {
      // Live mode "as of" is the latest event timestamp when events exist,
      // otherwise current wall-clock time. The fallback to now() prevents
      // the scrubber's readout from getting stuck at a stale lastScrubbedAt
      // value when the active store has no events.ndjson (e.g. an agent dir
      // that only contains atom files).
      return { atoms: this.fallback, asOf: this.lastEventTs() ?? new Date().toISOString() };
    }

    if (this.mode === 'scrubbed') {
      const target = this.playhead ?? this.lastEventTs();
      const map = replayEvents(this.events, {
        targetTimestamp: target,
        fallbackAtoms: this.fallback,
      });
      return { atoms: [...map.values()], asOf: target };
    }

    // diff
    // Defaults that make Diff useful without an explicit T1/T2 UI:
    //  - T1 = playhead → user-driven, "what's changed since this point?"
    //  - T2 = lastEventTs → the latest known state
    //
    // This makes Diff meaningfully different from Scrubbed:
    //  * atoms created after T1 → green (added)
    //  * atoms archived after T1 → red ghost (removed)
    //  * atoms updated after T1 → amber (mutated)
    //  * atoms unchanged in [T1, T2] → normal F2 colors
    //
    // Earlier versions defaulted T1 to epoch, which made `prev` empty and
    // every atom render as "added" (all-green) — visually identical to
    // Scrubbed except for color, which is what the user reported.
    // Explicit setDiffRange() still overrides these defaults.
    const lastTs = this.lastEventTs();
    const t1 = this.diffT1 ?? this.playhead ?? lastTs ?? '1970-01-01T00:00:00.000Z';
    const t2 = this.diffT2 ?? lastTs ?? new Date().toISOString();
    const prev = replayEvents(this.events, { targetTimestamp: t1, fallbackAtoms: this.fallback });
    const next = replayEvents(this.events, { targetTimestamp: t2, fallbackAtoms: this.fallback });
    const diff = diffStates(prev, next);
    // asOf in Diff mode = T1 (the diff window's start) so the readout and
    // the slider position both reflect the timestamp the user is dragging.
    return { atoms: diff.union(), diff, asOf: t1 };
  }

  private lastEventTs(): string | undefined {
    if (this.events.length === 0) return undefined;
    let max = this.events[0].timestamp;
    for (const e of this.events) {
      if (e.timestamp > max) max = e.timestamp;
    }
    return max;
  }
}
