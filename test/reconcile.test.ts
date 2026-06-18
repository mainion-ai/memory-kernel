/**
 * #364 — Phase 2 confidence write-back from grounding reconciliation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initMemoryDir, createAtom, listAtoms, closeAllIndexes } from '../src/index.js';
import { reconcileGrounding, reconciledConfidence, DEFAULT_ALPHA_NEG, DEFAULT_ALPHA_POS } from '../src/reconcile.js';
import { appendEvent, readEvents } from '../src/event-log.js';
import { readAtom } from '../src/store.js';
import { findAtomFile } from '../src/atom-lookup.js';

describe('reconciledConfidence (pure)', () => {
  it('pulls DOWN faster than UP (asymmetric α)', () => {
    // Same |diff| of 0.4 in each direction.
    const down = 0.8 - reconciledConfidence(0.8, 0.4); // disconfirmation magnitude
    const up = reconciledConfidence(0.4, 0.8) - 0.4; // confirmation magnitude
    expect(down).toBeCloseTo(DEFAULT_ALPHA_NEG * 0.4, 6);
    expect(up).toBeCloseTo(DEFAULT_ALPHA_POS * 0.4, 6);
    expect(down).toBeGreaterThan(up);
  });

  it('clamps to [0, 1] and never overshoots the grounding target', () => {
    expect(reconciledConfidence(1, 0)).toBeGreaterThanOrEqual(0);
    expect(reconciledConfidence(0, 1)).toBeLessThanOrEqual(1);
    // A single step never crosses grounding.
    const r = reconciledConfidence(0.9, 0.3);
    expect(r).toBeLessThan(0.9);
    expect(r).toBeGreaterThan(0.3);
  });
});

describe('reconcileGrounding (disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-reconcile-'));
    initMemoryDir(dir);
  });
  afterEach(() => {
    closeAllIndexes();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function newAtom(slug: string, confidence: number) {
    return createAtom({
      memoryDir: dir,
      agent_id: 'a',
      session_id: 's',
      type: 'fact',
      slug,
      body: `body ${slug}`,
      confidence,
      status: 'active',
      ttl_days: null,
    });
  }

  /** Seed atom_read events across `sessions` distinct sessions to ground an atom. */
  function seedReads(id: string, sessions: number, perSession: number) {
    for (let s = 0; s < sessions; s++) {
      for (let i = 0; i < perSession; i++) {
        appendEvent(dir, 'atom_read', { agent_id: 'a', session_id: `sess-${s}`, atom_refs: [id] });
      }
    }
  }

  it('pulls a confident-but-unused atom DOWN (review) and emits an audit event', () => {
    const atom = newAtom('confident-unused', 0.9); // never read → grounding 0.01 → review (actionable)

    const r = reconcileGrounding({ memoryDir: dir });
    expect(r.applied).toBe(1);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].quadrant).toBe('review');
    expect(r.changes[0].delta).toBeLessThan(0);

    const updated = readAtom(findAtomFile(dir, atom.frontmatter.id)!);
    expect(updated.frontmatter.confidence).toBeLessThan(0.9);
    expect(updated.frontmatter.confidence).toBe(r.changes[0].reconciled_confidence);

    const events = readEvents(dir).filter((e) => e.action === 'atom_reconciled');
    expect(events).toHaveLength(1);
    expect(events[0].atom_refs).toEqual([atom.frontmatter.id]);
    expect(events[0].meta?.operation).toBe('grounding-reconcile');
    expect(events[0].meta?.quadrant).toBe('review');
    expect(events[0].schema_version).toBe(2);
    expect(events[0].atom_snapshot).toBeTruthy();
  });

  it('pulls a cautious-but-corroborated atom UP (promote)', () => {
    const atom = newAtom('cautious-used', 0.3);
    seedReads(atom.frontmatter.id, 2, 4); // 2 sessions, recent → high grounding, actionable promote

    const r = reconcileGrounding({ memoryDir: dir });
    const change = r.changes.find((c) => c.atom_id === atom.frontmatter.id);
    expect(change).toBeDefined();
    expect(change!.quadrant).toBe('promote');
    expect(change!.delta).toBeGreaterThan(0);

    const updated = readAtom(findAtomFile(dir, atom.frontmatter.id)!);
    expect(updated.frontmatter.confidence).toBeGreaterThan(0.3);
  });

  it('skips atoms carrying a human_edit event (human-asserted confidence)', () => {
    const atom = newAtom('human-touched', 0.9); // would be a review write-back
    appendEvent(dir, 'human_edit', {
      agent_id: 'human-editor',
      session_id: 's',
      atom_refs: [atom.frontmatter.id],
      schema_version: 2,
      atom_snapshot: 'snap',
    });

    const r = reconcileGrounding({ memoryDir: dir });
    expect(r.applied).toBe(0);
    expect(r.skipped_human_edit).toBe(1);
    expect(readEvents(dir).filter((e) => e.action === 'atom_reconciled')).toHaveLength(0);

    const updated = readAtom(findAtomFile(dir, atom.frontmatter.id)!);
    expect(updated.frontmatter.confidence).toBe(0.9); // untouched
  });

  it('--override adjusts even human-edited atoms', () => {
    const atom = newAtom('human-touched-override', 0.9);
    appendEvent(dir, 'human_edit', {
      agent_id: 'human-editor',
      session_id: 's',
      atom_refs: [atom.frontmatter.id],
      schema_version: 2,
      atom_snapshot: 'snap',
    });

    const r = reconcileGrounding({ memoryDir: dir, override: true });
    expect(r.applied).toBe(1);
    expect(r.skipped_human_edit).toBe(0);
  });

  it('dry-run previews changes without mutating files or emitting events', () => {
    const atom = newAtom('preview', 0.9);

    const r = reconcileGrounding({ memoryDir: dir, dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.applied).toBe(0);
    expect(r.changes.length).toBe(1);

    expect(readEvents(dir).filter((e) => e.action === 'atom_reconciled')).toHaveLength(0);
    const updated = readAtom(findAtomFile(dir, atom.frontmatter.id)!);
    expect(updated.frontmatter.confidence).toBe(0.9);
  });

  it('leaves well-grounded and not-yet-actionable atoms untouched', () => {
    const wellGrounded = newAtom('well-grounded', 0.9);
    seedReads(wellGrounded.frontmatter.id, 3, 5); // high prior + high grounding → well-grounded
    newAtom('fresh-low', 0.3); // low prior, low grounding, too recent → noise, not actionable

    const r = reconcileGrounding({ memoryDir: dir });
    expect(r.changes.find((c) => c.atom_id === wellGrounded.frontmatter.id)).toBeUndefined();
    expect(r.applied).toBe(0);
  });

  it('honours minDelta — negligible adjustments are skipped', () => {
    newAtom('tiny-delta', 0.9); // review; natural delta ~0.07
    const r = reconcileGrounding({ memoryDir: dir, minDelta: 0.5 }); // force the skip branch
    expect(r.candidates).toBe(1);
    expect(r.applied).toBe(0);
    expect(r.skipped_below_min_delta).toBe(1);
  });

  it('rejects out-of-range learning-rate knobs (convexity guard)', () => {
    newAtom('guard', 0.9);
    expect(() => reconcileGrounding({ memoryDir: dir, alphaNeg: 5 })).toThrow(/alphaNeg/);
    expect(() => reconcileGrounding({ memoryDir: dir, alphaPos: -1 })).toThrow(/alphaPos/);
    expect(() => reconcileGrounding({ memoryDir: dir, minDelta: -0.1 })).toThrow(/minDelta/);
  });

  it('records the α the pull actually used in the audit event meta', () => {
    const atom = newAtom('alpha-meta', 0.9); // review → disconfirmation → alphaNeg
    reconcileGrounding({ memoryDir: dir });
    const ev = readEvents(dir).find((e) => e.action === 'atom_reconciled');
    expect(ev!.meta?.alpha).toBe(DEFAULT_ALPHA_NEG);
  });

  it('converges: a second pass moves confidence less and never overshoots grounding', () => {
    const atom = newAtom('converging', 0.95);
    const r1 = reconcileGrounding({ memoryDir: dir });
    const c1 = readAtom(findAtomFile(dir, atom.frontmatter.id)!).frontmatter.confidence;
    const r2 = reconcileGrounding({ memoryDir: dir });
    const c2 = readAtom(findAtomFile(dir, atom.frontmatter.id)!).frontmatter.confidence;

    expect(c1).toBeLessThan(0.95);
    expect(c2).toBeLessThan(c1); // still pulling down
    expect(c2).toBeGreaterThan(0.01); // never below the grounding floor
    // Second-pass step is smaller than the first (diminishing toward target).
    expect(0.95 - c1).toBeGreaterThan(c1 - c2);
    expect(r2.applied).toBeLessThanOrEqual(r1.applied);
  });
});
