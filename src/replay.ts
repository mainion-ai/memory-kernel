/**
 * Replay engine — deterministic state reconstruction from events.
 * Same events → identical atoms and views.
 */

import fs from 'fs';
import path from 'path';
import { parseAtom } from './format.js';
import { readEvidence } from './evidence.js';
import { AtomFrontmatterSchema, isMutationAction } from './schema.js';
import {
  renderIndex,
  renderDecisions,
  renderConstraints,
  renderOpenQuestions,
  renderHandoff,
} from './renderers.js';
import { assertWithinDir, writeFileAtomic, writeAtom, atomFilePath } from './store.js';
import type { Atom, MemoryEvent, ReplayResult } from './types.js';

/**
 * Replay events to reconstruct atom state and views.
 * Deterministic: same events (with fixed timestamp) → identical output.
 */
export function replay(
  events: MemoryEvent[],
  opts?: {
    evidenceDir?: string; // For resolving atom_snapshot_hash
    timestamp?: string; // Fixed timestamp for deterministic view rendering
  },
): ReplayResult {
  const atoms = new Map<string, Atom>();
  const errors: string[] = [];
  let processed = 0;

  for (const event of events) {
    processed++;

    if (!isMutationAction(event.action)) {
      continue; // Non-mutation events don't affect atom state
    }

    // Get snapshot (inline or via evidence hash)
    let snapshot: string | undefined = event.atom_snapshot;

    if (!snapshot && event.atom_snapshot_hash && opts?.evidenceDir) {
      try {
        const data = readEvidence(opts.evidenceDir, event.atom_snapshot_hash);
        snapshot = data.toString('utf-8');
      } catch (err) {
        errors.push(
          `Event ${event.event_id}: evidence ${event.atom_snapshot_hash} not found`,
        );
        continue;
      }
    }

    if (!snapshot) {
      // V1 event without snapshot — handle archive/expire by removing atom
      if (
        (event.action === 'atom_archived' || event.action === 'atom_expired') &&
        event.atom_refs
      ) {
        for (const ref of event.atom_refs) {
          atoms.delete(ref);
        }
        continue;
      }
      errors.push(
        `Event ${event.event_id}: no snapshot for ${event.action}`,
      );
      continue;
    }

    try {
      const atom = parseAtom(snapshot);

      const validation = AtomFrontmatterSchema.safeParse(atom.frontmatter);
      if (!validation.success) {
        errors.push(
          `Event ${event.event_id}: invalid snapshot — ${validation.error.issues.map((i) => i.message).join(', ')}`,
        );
        continue;
      }

      const id = atom.frontmatter.id;

      if (
        event.action === 'atom_archived' ||
        event.action === 'atom_expired'
      ) {
        atoms.delete(id);
      } else {
        atoms.set(id, atom);
      }
    } catch (err) {
      errors.push(
        `Event ${event.event_id}: failed to parse snapshot: ${String(err)}`,
      );
    }
  }

  // Generate views from reconstructed atoms
  const atomList = Array.from(atoms.values());
  const ts = opts?.timestamp;

  const views = {
    index: renderIndex(atomList, ts),
    decisions: renderDecisions(atomList, ts),
    constraints: renderConstraints(atomList, ts),
    open_questions: renderOpenQuestions(atomList, ts),
    handoff: renderHandoff(atomList, events, ts),
  };

  return {
    atoms,
    views,
    events_processed: processed,
    errors,
  };
}

// --- View name mapping ---

const VIEW_FILE_MAP: Record<string, string> = {
  index: 'INDEX.md',
  decisions: 'DECISIONS.md',
  constraints: 'CONSTRAINTS.md',
  open_questions: 'OPEN_QUESTIONS.md',
  handoff: 'HANDOFF.md',
};

/**
 * Replay from an events file on disk.
 * Optionally writes reconstructed atoms and views to outputDir.
 */
export function replayFromFile(
  eventsFile: string,
  opts?: {
    evidenceDir?: string;
    outputDir?: string;
    timestamp?: string;
  },
): ReplayResult {
  const content = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf-8').trim()
    : '';

  if (!content) {
    const emptyViews = {
      index: renderIndex([], opts?.timestamp),
      decisions: renderDecisions([], opts?.timestamp),
      constraints: renderConstraints([], opts?.timestamp),
      open_questions: renderOpenQuestions([], opts?.timestamp),
      handoff: renderHandoff([], [], opts?.timestamp),
    };
    return {
      atoms: new Map(),
      views: emptyViews,
      events_processed: 0,
      errors: [],
    };
  }

  const parseErrors: string[] = [];
  const events: MemoryEvent[] = content.split('\n').flatMap((line, idx) => {
    if (!line.trim()) return []; // Skip blank lines silently
    try {
      return [JSON.parse(line) as MemoryEvent];
    } catch {
      parseErrors.push(`Line ${idx + 1}: invalid JSON`);
      return [];
    }
  });

  const result = replay(events, opts);

  // Surface JSON parse errors alongside replay errors
  if (parseErrors.length > 0) {
    result.errors.push(...parseErrors);
  }

  // Optionally write output to disk
  if (opts?.outputDir) {
    const outDir = opts.outputDir;
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(path.join(outDir, 'ENTITIES'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'CONFLICTS'), { recursive: true });

    // Write views
    for (const [name, content] of Object.entries(result.views)) {
      const fileName = VIEW_FILE_MAP[name];
      if (fileName) {
        writeFileAtomic(path.join(outDir, fileName), content);
      }
    }

    // Write atoms (with path traversal guard against crafted atom IDs)
    for (const [_id, atom] of result.atoms) {
      const fp = atomFilePath(outDir, atom.frontmatter.id, atom.frontmatter.type);
      assertWithinDir(outDir, fp);
      writeAtom(atom, fp);
    }
  }

  return result;
}
