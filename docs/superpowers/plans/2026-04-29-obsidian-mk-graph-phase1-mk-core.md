# Obsidian mk-graph — Phase 1 (mk core changes) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the mk-core changes that unblock the Obsidian plugin: (a) extend `Relation` with five new optional fields (`created_at`, `confidence`, `weight`, `source`, `evidence`), (b) ship `mk timeline --json` for replay-ready event streams, (c) add `--as-of <iso>` to `mk wander`, all backward-compatible.

**Architecture:** All changes are additive and optional. `Relation` keeps its `{target, type}` shape; new fields default to undefined on parse and are populated opportunistically at write time (`retain.ts` auto-relink → `'extracted'`, `enrich-relations.ts` → `'enriched'`, explicit callers → `'manual'`). `mk timeline --json` is a thin denormalising wrapper around the existing `replay()` (resolves evidence hashes, decrypts SECRET when key is set, filters by time range). `mk wander --as-of` reuses `replay()` to reconstruct atoms-as-of-T then runs the existing wander algorithm against an in-memory atom list. PR #28's `LEGACY_TYPED_LINK_KEYS` stripper stays untouched — the new fields live inside the `relations[]` array, not as top-level Juggl keys. SQLite index changes are out of scope (the plugin reads files; wander doesn't yet consume new fields).

**Tech Stack:** TypeScript, Zod (validation), Commander.js (CLI), vitest (tests), js-yaml + gray-matter (frontmatter), AES-256-GCM (existing crypto), better-sqlite3 (existing index, untouched in this phase).

**Spec:** [docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md](../specs/2026-04-28-obsidian-mk-graph-design.md) §4

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Extend `Relation` interface with five optional fields; export `RELATION_SOURCES` constant |
| `src/schema.ts` | Modify | Extend `AtomFrontmatterSchema.relations` Zod entry with five optional fields |
| `src/format.ts` | No code change | Verify `serializeFrontmatter` already emits all properties via `yaml.dump` (it does — relations live in the array, no special handling needed) |
| `src/retain.ts` | Modify | `createAtom` auto-relink path sets `source: 'extracted'` + `created_at` on extracted relations; explicit caller path sets `source: 'manual'` + `created_at` defaults when missing |
| `src/enrich-relations.ts` | Modify | When converting an enrichment proposal to a `Relation`, set `source: 'enriched'`, `confidence` from proposal, `created_at` from now |
| `src/timeline.ts` | Create | Library: `getTimeline({memoryDir, from?, to?, includeEvidence?})` returns denormalised events (snapshots inline, decrypted, evidence resolved) |
| `src/wander.ts` | Modify | Add `wanderFromAtoms(atoms, options)` — runs spreading activation against a pre-built atom list (used by wander --as-of) |
| `src/cli/mk.ts` | Modify | Add `mk timeline` command; add `--as-of <iso>` flag to `mk wander` |
| `src/index.ts` | Modify | Export `getTimeline`, `RELATION_SOURCES`, `wanderFromAtoms`, `applyProposals` |
| `test/relations.test.ts` | Modify | Add tests: new field round-trip, legacy compat, source population on auto-relink, defaults on explicit relations |
| `test/format-relations-extension.test.ts` | Create | Pure round-trip tests for parse/serialise of new fields + LEGACY_TYPED_LINK_KEYS regression |
| `test/timeline.test.ts` | Create | Library-level tests for `getTimeline` (filter, decrypt, hash resolve, denormalise) |
| `test/cli-timeline.test.ts` | Create | End-to-end CLI test for `mk timeline --json` (subprocess via execFileSync, golden JSON shape) |
| `test/wander-as-of.test.ts` | Create | Determinism tests: `wander --as-of T` returns identical results across runs; recently-created atoms not present at time T do not surface |
| `package.json` | Modify | `"version": "1.17.0"` |
| `package-lock.json` | Modify | Top-level + self-entry both → `1.17.0` |
| `packages/openclaw-memory-kernel/package.json` | Modify | `"memory-kernel": "^1.17.0"` |
| `CHANGELOG.md` | Modify | Move applicable `[Unreleased]` items into `## [1.17.0] — 2026-04-29` |

**Out of scope for this phase:** SQLite `atom_relations` table (no new columns — visualization plugin reads files; wander doesn't consume new fields yet). Plugin scaffolding under `packages/obsidian-mk-graph/`. UI work of any kind.

---

## Task 1: Extend `Relation` interface and Zod schema

**Files:**
- Modify: `src/types.ts:77-92`
- Modify: `src/schema.ts:47-54`
- Create: `test/format-relations-extension.test.ts`

- [ ] **Step 1.1: Write the failing test for new-field round-trip**

Create `test/format-relations-extension.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseAtom, serializeAtom } from '../src/format.js';
import type { Atom } from '../src/types.js';

describe('Relation schema extension', () => {
  it('parses an atom whose relations have all five new fields', () => {
    const md = `---
id: FACT-2026-04-29-EXAMPLE-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: extends
    created_at: "2026-04-29T10:30:00Z"
    confidence: 0.85
    weight: 1.6
    source: manual
    evidence:
      - FACT-2026-04-25-EVI-cc02
---

Body content.
`;
    const atom = parseAtom(md);
    expect(atom.frontmatter.relations).toEqual([
      {
        target: 'FACT-2026-04-28-OTHER-bb01',
        type: 'extends',
        created_at: '2026-04-29T10:30:00Z',
        confidence: 0.85,
        weight: 1.6,
        source: 'manual',
        evidence: ['FACT-2026-04-25-EVI-cc02'],
      },
    ]);
  });

  it('parses a legacy {target, type}-only relation without applying defaults', () => {
    const md = `---
id: FACT-2026-04-29-LEGACY-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: extends
---

Body.
`;
    const atom = parseAtom(md);
    const rel = atom.frontmatter.relations![0];
    expect(rel.target).toBe('FACT-2026-04-28-OTHER-bb01');
    expect(rel.type).toBe('extends');
    expect(rel.created_at).toBeUndefined();
    expect(rel.confidence).toBeUndefined();
    expect(rel.weight).toBeUndefined();
    expect(rel.source).toBeUndefined();
    expect(rel.evidence).toBeUndefined();
  });

  it('round-trips an atom with new fields without modifying them', () => {
    const original: Atom = {
      frontmatter: {
        id: 'FACT-2026-04-29-RT-aa00',
        type: 'fact',
        status: 'active',
        confidence: 0.9,
        created_at: '2026-04-29T10:00:00Z',
        updated_at: '2026-04-29T10:00:00Z',
        ttl_days: null,
        relations: [
          {
            target: 'FACT-2026-04-28-X-bb01',
            type: 'supports',
            created_at: '2026-04-29T10:30:00Z',
            confidence: 0.7,
            weight: 0.9,
            source: 'enriched',
            evidence: ['FACT-2026-04-25-A-cc02'],
          },
        ],
      },
      body: 'Body.',
    };
    const md = serializeAtom(original);
    const reparsed = parseAtom(md);
    expect(reparsed.frontmatter.relations).toEqual(original.frontmatter.relations);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `npx vitest run test/format-relations-extension.test.ts`
Expected: tests fail because the typecheck refuses unknown `confidence`/`weight`/etc. on `Relation`, OR (after Zod validation runs) the schema rejects the extra keys.

- [ ] **Step 1.3: Extend the `Relation` interface**

In `src/types.ts`, replace lines 77-92 with:

```typescript
// --- Relation types (Phase 3) ---

export const RELATION_TYPES = [
  'extends',
  'contradicts',
  'supports',
  'caused_by',
  'supersedes',
  'applied_to',
  'related',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** How a relation came into existence. Used for visualization (manual=solid,
 *  extracted=dashed, enriched=dotted) and audit. */
export const RELATION_SOURCES = [
  'manual',
  'extracted',
  'enriched',
  'unknown',
] as const;

export type RelationSource = (typeof RELATION_SOURCES)[number];

export interface Relation {
  target: string; // Atom ID
  type: RelationType;
  /** ISO8601 — when the edge was created. Optional; consumers fall back to
   *  the source atom's created_at for legacy edges. */
  created_at?: string;
  /** 0..1 — belief in the relation. Defaults to 1.0 at consumption time. */
  confidence?: number;
  /** Per-edge wander weight. When undefined, falls back to the type-level
   *  default in DEFAULT_TYPE_WEIGHTS. */
  weight?: number;
  /** Provenance of the edge. */
  source?: RelationSource;
  /** Pointers to supporting atoms / episodes / evidence hashes. */
  evidence?: string[];
}
```

- [ ] **Step 1.4: Extend the Zod schema**

In `src/schema.ts`, replace lines 47-54 with:

```typescript
  relations: z
    .array(
      z.object({
        target: z.string().min(1),
        type: z.enum(RELATION_TYPES),
        created_at: z.string().datetime().optional(),
        confidence: z.number().min(0).max(1).optional(),
        weight: z.number().optional(),
        source: z.enum(RELATION_SOURCES).optional(),
        evidence: z.array(z.string()).optional(),
      }),
    )
    .optional(),
```

In `src/schema.ts`, line 13 (`import` block from `./types.js`), add `RELATION_SOURCES` to the imports:

```typescript
import {
  ATOM_STATUSES,
  ATOM_TYPES,
  CLASSIFICATIONS,
  EVENT_ACTIONS,
  RELATION_SOURCES,
  RELATION_TYPES,
} from './types.js';
```

- [ ] **Step 1.5: Run the test to verify it passes**

Run: `npx vitest run test/format-relations-extension.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 1.6: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests pass plus the 3 new ones; total ≥ previous count + 3.

- [ ] **Step 1.7: Commit**

```bash
git add src/types.ts src/schema.ts test/format-relations-extension.test.ts
git commit -m "$(cat <<'EOF'
feat(types): extend Relation with optional metadata fields

Add five optional fields to Relation: created_at, confidence, weight,
source, evidence. Introduces RELATION_SOURCES constant. All fields are
optional; legacy {target, type} relations parse unchanged. Powers Phase 1
of the obsidian-mk-graph plugin (visualization needs per-edge metadata).

Refs docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md §4.1

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: LEGACY_TYPED_LINK_KEYS regression test

**Files:**
- Modify: `test/format-relations-extension.test.ts`

The risk: extending `Relation` could accidentally re-introduce Juggl-style top-level frontmatter keys. PR #28 explicitly stripped these. Lock the behavior in.

- [ ] **Step 2.1: Write the failing test**

Append to `test/format-relations-extension.test.ts`:

```typescript
describe('PR #28 LEGACY_TYPED_LINK_KEYS regression', () => {
  it('strips legacy Juggl keys on parse and never re-emits them on serialise', () => {
    const mdWithLegacyJugglKeys = `---
id: FACT-2026-04-29-LEG-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
extends:
  - "[[FACT-OLD-1]]"
supports:
  - "[[FACT-OLD-2]]"
caused-by:
  - "[[FACT-OLD-3]]"
relations:
  - target: FACT-2026-04-28-NEW-bb01
    type: extends
    source: manual
---

Body.
`;
    const atom = parseAtom(mdWithLegacyJugglKeys);
    // Legacy keys must be stripped from the parsed frontmatter
    const fm = atom.frontmatter as unknown as Record<string, unknown>;
    expect(fm.extends).toBeUndefined();
    expect(fm.supports).toBeUndefined();
    expect(fm['caused-by']).toBeUndefined();

    // Round-trip must not re-emit them
    const reSerialised = serializeAtom(atom);
    expect(reSerialised).not.toMatch(/^extends:/m);
    expect(reSerialised).not.toMatch(/^supports:/m);
    expect(reSerialised).not.toMatch(/^caused-by:/m);
    // The new relations[] array must be preserved
    expect(reSerialised).toMatch(/^relations:/m);
  });

  it('canonical relations[] array does not get confused with legacy top-level keys', () => {
    const md = `---
id: FACT-2026-04-29-CAN-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: extends
    source: extracted
    created_at: "2026-04-29T10:30:00Z"
---

Body.
`;
    const atom = parseAtom(md);
    expect(atom.frontmatter.relations).toHaveLength(1);
    const out = serializeAtom(atom);
    // Ensure no legacy form is emitted
    expect(out).not.toMatch(/^extends:\s*\n\s*-\s*"\[\[/m);
  });
});
```

- [ ] **Step 2.2: Run the test**

Run: `npx vitest run test/format-relations-extension.test.ts`
Expected: PASS — Task 1 already produced correct behavior; this test locks it in.

- [ ] **Step 2.3: Commit**

```bash
git add test/format-relations-extension.test.ts
git commit -m "$(cat <<'EOF'
test(format): regression test for LEGACY_TYPED_LINK_KEYS stripper

Lock in PR #28 behavior: legacy Juggl-style top-level keys (extends,
supports, caused-by, etc.) are stripped on parse and never re-emitted
on serialise, even when the canonical relations[] array is present
with the new metadata fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Auto-relink populates `source: 'extracted'` and `created_at`

**Files:**
- Modify: `src/retain.ts:99-122`
- Modify: `test/relations.test.ts` (extend existing file)

- [ ] **Step 3.1: Write the failing test**

Append to `test/relations.test.ts`:

```typescript
describe('Phase 1 plugin: auto-relink populates source and created_at', () => {
  it('marks auto-extracted relations with source=extracted and a created_at', () => {
    // First, create a target atom that will be referenced
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'target-of-relink',
      body: 'A target fact.',
    });

    // Now create an atom whose body references the target by ID
    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-relink',
      body: `This belief references ${target.frontmatter.id} explicitly.`,
    });

    expect(source.frontmatter.relations).toBeDefined();
    expect(source.frontmatter.relations!.length).toBeGreaterThan(0);
    const rel = source.frontmatter.relations!.find(r => r.target === target.frontmatter.id);
    expect(rel).toBeDefined();
    expect(rel!.source).toBe('extracted');
    expect(rel!.created_at).toBeDefined();
    // Created_at should be a valid ISO8601 within the last minute
    const ts = new Date(rel!.created_at!).getTime();
    expect(Date.now() - ts).toBeLessThan(60_000);
  });

  it('explicit caller-supplied relations default to source=manual when source is missing', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'manual-target',
      body: 'Manual target.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-manual-relation',
      body: 'No body references; explicit relations only.',
      relations: [{ target: target.frontmatter.id, type: 'extends' }],
    });

    expect(source.frontmatter.relations).toEqual([
      expect.objectContaining({
        target: target.frontmatter.id,
        type: 'extends',
        source: 'manual',
        created_at: expect.any(String),
      }),
    ]);
  });

  it('explicit caller-supplied source is preserved when set', () => {
    const target = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'enriched-target',
      body: 'Target.',
    });

    const source = createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'belief', slug: 'has-enriched-relation',
      body: 'Body.',
      relations: [{
        target: target.frontmatter.id,
        type: 'supports',
        source: 'enriched',
        confidence: 0.72,
      }],
    });

    const rel = source.frontmatter.relations![0];
    expect(rel.source).toBe('enriched');
    expect(rel.confidence).toBe(0.72);
  });
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `npx vitest run test/relations.test.ts -t "auto-relink populates source"`
Expected: FAIL — current code stores plain `{target, type}` only.

- [ ] **Step 3.3: Update `retain.ts` auto-relink path**

In `src/retain.ts`, replace lines 99-122 (the auto-relink block in `createAtom`) with:

```typescript
  // Auto-relink: extract body-text references and add as relations.
  // Runs before event emission so the snapshot includes extracted relations.
  // Skips if the caller already provided explicit relations to avoid double-linking.
  // Extracts both atom-ID references and concept-name references.
  if (!opts.relations?.length && indexExists(opts.memoryDir)) {
    const knownIds = getAllAtomIds(opts.memoryDir);
    const idRefs = extractBodyReferences(atom.body, id, knownIds);

    // Concept-name references: build map from atom IDs (cheap SQLite query)
    const conceptMap = buildConceptMap(knownIds);
    const conceptRefs = extractConceptReferences(atom.body, id, conceptMap);

    // Merge and deduplicate (atom-ID refs take priority since they come first)
    const allRefs = deduplicateRefs([...idRefs, ...conceptRefs]);

    if (allRefs.length > 0) {
      atom.frontmatter.relations = [
        ...(atom.frontmatter.relations ?? []),
        ...allRefs.map((r) => ({
          target: r.targetId,
          type: r.type,
          source: 'extracted' as const,
          created_at: now,
        })),
      ];
      writeAtom(atom, fp);
      indexAtom(opts.memoryDir, atom);
    }
  }

  // Caller-supplied relations: default source='manual' and created_at if missing
  if (opts.relations?.length) {
    atom.frontmatter.relations = opts.relations.map((r) => ({
      ...r,
      source: r.source ?? ('manual' as const),
      created_at: r.created_at ?? now,
    }));
    writeAtom(atom, fp);
    if (indexExists(opts.memoryDir)) {
      indexAtom(opts.memoryDir, atom);
    }
  }
```

The `now` constant is already defined in `createAtom` at line 58 (`const now = normalizeTimestamp();`); reuse it.

- [ ] **Step 3.4: Run the test to verify it passes**

Run: `npx vitest run test/relations.test.ts -t "auto-relink populates source"`
Expected: 3 PASS.

- [ ] **Step 3.5: Run the full test suite**

Run: `npm test`
Expected: all tests pass, no regressions in relations / retain / kernel suites.

- [ ] **Step 3.6: Commit**

```bash
git add src/retain.ts test/relations.test.ts
git commit -m "$(cat <<'EOF'
feat(retain): populate source and created_at on relations

createAtom now sets:
- source='extracted' + created_at=now on auto-relinked references
- source='manual' + created_at=now on caller-supplied relations
  when those fields aren't already present

Caller-supplied source/created_at/confidence/weight/evidence pass through
unchanged. Powers visualization plugin's edge-style differentiation
(manual=solid, extracted=dashed, enriched=dotted).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `enrich-relations.ts` populates `source: 'enriched'` and `confidence` on apply

**Files:**
- Modify: `src/enrich-relations.ts:306-332` (apply block)
- Modify: `test/enrich-relations.test.ts`

The enrichment pipeline does NOT create new `Relation` objects — it mutates existing `related`-type relations in place when the LLM reclassifies them (see `src/enrich-relations.ts:309-329`). The mutation currently changes only `rel.type`. We need it to also stamp `source='enriched'` and `confidence` from the proposal.

**Decision:** Do NOT update `rel.created_at` on enrichment. The underlying edge existed before the LLM reclassified it; only the classification changed. (A future "reclassified_at" field could capture the enrichment moment if needed, but that's out of scope.)

- [ ] **Step 4.1: Write the failing test**

Append to `test/enrich-relations.test.ts` (existing test file — match its style for setup/teardown). Read the top of the file first via `head -30 test/enrich-relations.test.ts` to confirm imports and the `testDir` pattern.

```typescript
describe('Phase 1 plugin: applied proposals carry source and confidence', () => {
  it('mutates source=enriched and confidence on apply', async () => {
    // Build a small fixture with one `related` edge that the apply path will reclassify.
    // Reuse the existing test scaffolding for setting up two atoms with a related edge —
    // see how earlier tests in this file create atoms and seed relations.

    const atomA = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'enrich-source', body: 'Source body.',
    });
    const atomB = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'enrich-target', body: 'Target body.',
      relations: [{ target: atomA.frontmatter.id, type: 'related' }],
    });

    // Construct a synthetic proposal as if the LLM reclassified the edge to 'extends'
    const proposal = {
      sourceId: atomB.frontmatter.id,
      targetId: atomA.frontmatter.id,
      oldType: 'related' as const,
      newType: 'extends' as const,
      confidence: 0.83,
      reasoning: 'B builds on A',
    };

    // Call the internal applyProposals helper (or whatever the apply path is named).
    // If apply is only reachable through the top-level enrichRelations() function,
    // call that with `dryRun: false` and a stub LLM that returns this proposal.
    // Refer to existing tests in test/enrich-relations.test.ts for the stubbing pattern.
    applyProposals(testDir, [proposal]);

    // Re-read atom B from disk and check the relation was updated correctly
    const reloaded = readAtom(atomB.filePath!);
    const rel = reloaded.frontmatter.relations!.find(
      (r) => r.target === atomA.frontmatter.id,
    );
    expect(rel).toBeDefined();
    expect(rel!.type).toBe('extends');
    expect(rel!.source).toBe('enriched');
    expect(rel!.confidence).toBe(0.83);
  });
});
```

The test names a helper `applyProposals(memoryDir, proposals)` which we'll extract from the inline apply block in step 4.3. If the existing tests already exercise the apply block via the top-level function, route the test through that path instead — but extracting a small helper makes the unit test cleaner.

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `npx vitest run test/enrich-relations.test.ts -t "applied proposals carry source"`
Expected: FAIL — `applyProposals` not exported, OR (if you routed via top-level function) the assertion on `rel.source === 'enriched'` fails because the apply block only changes `rel.type`.

- [ ] **Step 4.3: Extract and update the apply block**

In `src/enrich-relations.ts`, locate the apply block at lines 306-332. Extract the inner loop into a new exported helper at the bottom of the file:

```typescript
/**
 * Apply enrichment proposals to atom files: reclassify the matched
 * `related` edges to their proposed types, stamping source='enriched'
 * and confidence from the proposal.
 *
 * Mutates atom files on disk and reindexes when an index exists.
 * Returns the number of proposals successfully applied.
 */
export function applyProposals(
  memoryDir: string,
  proposals: EnrichmentProposal[],
): number {
  // Build a one-time lookup of atoms by id by listing the directory.
  const allAtoms = listAtoms(memoryDir);
  const atomMap = new Map<string, Atom>();
  for (const a of allAtoms) {
    if (a.frontmatter.id) atomMap.set(a.frontmatter.id, a);
  }

  let applied = 0;
  for (const proposal of proposals) {
    try {
      const atom = atomMap.get(proposal.sourceId);
      if (!atom?.filePath || !atom.frontmatter.relations) continue;

      const rel = atom.frontmatter.relations.find(
        (r) => r.target === proposal.targetId && r.type === 'related',
      );
      if (rel) {
        rel.type = proposal.newType;
        rel.source = 'enriched';
        rel.confidence = proposal.confidence;
        assertWithinDir(memoryDir, atom.filePath);
        writeAtom(atom, atom.filePath);
        if (indexExists(memoryDir)) {
          indexAtom(memoryDir, atom);
        }
        applied++;
      }
    } catch {
      process.stderr.write(`Warning: failed to apply ${proposal.sourceId} -> ${proposal.targetId}\n`);
    }
  }
  return applied;
}
```

Then replace the inline apply block at lines 306-332 of `src/enrich-relations.ts` with a call to the new helper:

```typescript
  // Apply mode: update frontmatter and reindex
  if (!options.dryRun && proposals.length > 0) {
    enrichResult.applied = applyProposals(memoryDir, proposals);
  }
```

Note: the helper rebuilds `atomMap` from the directory because the inline version had access to a local `atomMap` already in scope. If reusing the existing `atomMap` is preferable for performance, accept it as a third parameter (`applyProposals(memoryDir, proposals, atomMap)`) and pass `atomMap` from the call site. Either way, the test in 4.1 must pass.

- [ ] **Step 4.4: Run the test to verify it passes**

Run: `npx vitest run test/enrich-relations.test.ts -t "applied proposals carry source"`
Expected: PASS.

- [ ] **Step 4.5: Run full suite**

Run: `npm test`
Expected: all tests pass; existing `enrich-relations.test.ts` tests still green plus the new one.

- [ ] **Step 4.6: Commit**

```bash
git add src/enrich-relations.ts test/enrich-relations.test.ts
git commit -m "$(cat <<'EOF'
feat(enrich): stamp source=enriched and confidence on applied proposals

When the enrichment pipeline reclassifies a 'related' edge to a more
specific type (extends/supports/etc.), also stamp source='enriched' and
confidence from the LLM proposal. Powers visualization plugin's edge
opacity (confidence) and dash style (source=enriched → dotted).

Extracts the inline apply block into an exported applyProposals() helper
for clean unit testing. created_at on the relation stays unchanged —
the edge predates the reclassification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `getTimeline()` library function

**Files:**
- Create: `src/timeline.ts`
- Create: `test/timeline.test.ts`
- Modify: `src/index.ts` (export)

- [ ] **Step 5.1: Write the failing test**

Create `test/timeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  closeAllIndexes,
} from '../src/index.js';
import { getTimeline } from '../src/timeline.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-timeline-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('getTimeline', () => {
  it('returns events with inline atom_snapshot for v2 mutation events', () => {
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'first',
      body: 'First fact.',
    });

    const result = getTimeline({ memoryDir: testDir });
    expect(result.events.length).toBeGreaterThan(0);
    const created = result.events.find(e => e.action === 'atom_created');
    expect(created).toBeDefined();
    expect(created!.atom_snapshot).toBeDefined();
    expect(created!.atom_snapshot).toMatch(/type: fact/);
  });

  it('filters events by from/to time range', () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    createAtom({
      memoryDir: testDir,
      agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'a',
      body: 'A.',
    });
    const after = new Date(Date.now() + 60_000).toISOString();

    // Time window includes the just-created atom
    const inWindow = getTimeline({ memoryDir: testDir, from: before, to: after });
    expect(inWindow.events.length).toBeGreaterThan(0);

    // Time window before atom existed: empty
    const empty = getTimeline({
      memoryDir: testDir,
      from: '2020-01-01T00:00:00Z',
      to: '2020-01-02T00:00:00Z',
    });
    expect(empty.events).toHaveLength(0);
  });

  it('emits redacted snapshot for SECRET atoms when key is unavailable at read time', () => {
    // SECRET atoms are only encrypted when a key is present at WRITE time
    // (see snapshotAtom() in src/retain.ts). To exercise the redaction path,
    // we set a key during create (encrypts the snapshot), then unset it before
    // calling getTimeline (forces the decryption-failure → redacted=true path).
    const previousKey = process.env.MEMORY_ENCRYPTION_KEY;
    process.env.MEMORY_ENCRYPTION_KEY = 'test-key-32-bytes-aaaaaaaaaaaaaa';

    try {
      createAtom({
        memoryDir: testDir,
        agent_id: 'a', session_id: 's',
        type: 'fact', slug: 'secret',
        body: 'Secret content.',
        classification: 'SECRET',
      });

      // Now unset the key — getTimeline will see encrypted snapshots it cannot decrypt
      delete process.env.MEMORY_ENCRYPTION_KEY;

      const result = getTimeline({ memoryDir: testDir });
      const created = result.events.find(e => e.action === 'atom_created');
      expect(created!.redacted).toBe(true);
      expect(created!.atom_snapshot).toBeUndefined();
    } finally {
      if (previousKey !== undefined) process.env.MEMORY_ENCRYPTION_KEY = previousKey;
      else delete process.env.MEMORY_ENCRYPTION_KEY;
    }
  });

  it('returns events sorted by timestamp ascending', () => {
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'first', body: '1' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'second', body: '2' });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's', type: 'fact', slug: 'third', body: '3' });

    const result = getTimeline({ memoryDir: testDir });
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i].timestamp >= result.events[i - 1].timestamp).toBe(true);
    }
  });
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `npx vitest run test/timeline.test.ts`
Expected: all FAIL — `src/timeline.ts` does not exist.

- [ ] **Step 5.3: Implement `src/timeline.ts`**

Create `src/timeline.ts`:

```typescript
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

    const tEvent: TimelineEvent = {
      event_id: ev.event_id,
      timestamp: ev.timestamp,
      agent_id: ev.agent_id,
      session_id: ev.session_id,
      action: ev.action,
      atom_refs: ev.atom_refs,
      touched_paths: ev.touched_paths,
      evidence: ev.evidence,
      meta: ev.meta,
      schema_version: ev.schema_version,
      atom_snapshot: snapshot,
      ...(redacted ? { redacted: true } : {}),
    };
    out.push(tEvent);
  }

  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { events: out };
}
```

- [ ] **Step 5.4: Add the export to `src/index.ts`**

In `src/index.ts`, add:

```typescript
export { getTimeline } from './timeline.js';
export type { TimelineEvent, TimelineOptions, TimelineResult } from './timeline.js';
export { RELATION_SOURCES, type RelationSource } from './types.js';
export { applyProposals } from './enrich-relations.js';
```

(Place these alongside existing barrel exports — match the surrounding style. `applyProposals` was created in Task 4 and is already exported from `enrich-relations.ts`; this just adds it to the package barrel.)

- [ ] **Step 5.5: Run the test to verify it passes**

Run: `npx vitest run test/timeline.test.ts`
Expected: 4 PASS.

- [ ] **Step 5.6: Run full suite**

Run: `npm test`
Expected: all tests pass; +4.

- [ ] **Step 5.7: Commit**

```bash
git add src/timeline.ts src/index.ts test/timeline.test.ts
git commit -m "$(cat <<'EOF'
feat(timeline): add getTimeline() for replay-ready event streams

New library function that reads events.ndjson, resolves atom_snapshot_hash
via the evidence dir, decrypts SECRET snapshots when MEMORY_ENCRYPTION_KEY
is set, filters by time range, and sorts ascending.

SECRET events without a decryption key emit redacted=true and omit
atom_snapshot — consumer (visualization plugin) renders these as redacted
nodes rather than failing.

Refs docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md §4.2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `mk timeline --json` CLI command

**Files:**
- Modify: `src/cli/mk.ts` (add command after `mk replay`)
- Create: `test/cli-timeline.test.ts`

- [ ] **Step 6.1: Write the failing test**

Create `test/cli-timeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';

const MK_BIN = path.resolve('dist/cli/mk.js');

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-cli-timeline-'));
  initMemoryDir(testDir);
  createAtom({
    memoryDir: testDir, agent_id: 'a', session_id: 's',
    type: 'fact', slug: 'one', body: 'One.',
  });
  createAtom({
    memoryDir: testDir, agent_id: 'a', session_id: 's',
    type: 'belief', slug: 'two', body: 'Two.',
  });
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('mk timeline --json', () => {
  it('outputs a JSON document with an events array', () => {
    if (!fs.existsSync(MK_BIN)) {
      // Skip silently when build not present — CI runs `npm run build` first
      return;
    }
    const out = execFileSync('node', [MK_BIN, 'timeline', '-d', testDir, '--json'], { encoding: 'utf-8' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('events');
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBeGreaterThanOrEqual(2);
    expect(parsed.events[0]).toMatchObject({
      event_id: expect.any(String),
      timestamp: expect.any(String),
      action: expect.any(String),
    });
  });

  it('respects --from and --to filters', () => {
    if (!fs.existsSync(MK_BIN)) return;
    const ancient = '2020-01-01T00:00:00Z';
    const out = execFileSync(
      'node',
      [MK_BIN, 'timeline', '-d', testDir, '--from', '2020-01-01T00:00:00Z', '--to', '2020-12-31T00:00:00Z', '--json'],
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.events).toEqual([]);
  });
});
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `npm run build && npx vitest run test/cli-timeline.test.ts`
Expected: FAIL — `mk timeline` is not a registered command.

- [ ] **Step 6.3: Add the command**

In `src/cli/mk.ts`, locate the `// --- mk replay ---` block (around line 724) and insert this block immediately after it:

```typescript
// --- mk timeline ---
program
  .command('timeline')
  .description('Emit replay-ready event stream (denormalised, decrypted, time-filtered)')
  .option('-d, --dir <dir>', 'Memory directory', './memory')
  .option('--from <iso>', 'Inclusive lower bound on event.timestamp (ISO8601)')
  .option('--to <iso>', 'Inclusive upper bound on event.timestamp (ISO8601)')
  .option('--json', 'Output as JSON (default and currently the only format)')
  .action((opts: { dir: string; from?: string; to?: string; json?: boolean }) => {
    const memoryDir = resolveDir(opts.dir, getAgent());
    if (!fs.existsSync(memoryDir)) {
      exitWithError(`Memory directory not found: ${memoryDir}\n  Run "mk init" first.`, true);
    }
    const result = getTimeline({
      memoryDir,
      from: opts.from,
      to: opts.to,
    });
    console.log(JSON.stringify(result, null, 2));
  });
```

Add `getTimeline` to the existing `import` block from `../timeline.js` at the top of `src/cli/mk.ts`. Find the import block alongside other library imports and add:

```typescript
import { getTimeline } from '../timeline.js';
```

- [ ] **Step 6.4: Build and run the test**

Run: `npm run build && npx vitest run test/cli-timeline.test.ts`
Expected: 2 PASS.

- [ ] **Step 6.5: Run full suite**

Run: `npm test`
Expected: pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/cli/mk.ts test/cli-timeline.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add mk timeline command

Thin CLI wrapper around getTimeline(). Supports -d/--dir, --from <iso>,
--to <iso>, and --json (currently the only output format, included for
forward-compat with the existing CLI flag convention).

Used by the obsidian-mk-graph plugin to read replay-ready event streams
without re-implementing evidence-hash deref or SECRET decryption.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `wanderFromAtoms()` helper

**Files:**
- Modify: `src/wander.ts`
- Modify: `src/index.ts` (export)

`wanderFromFiles` reads atom files via `listAtoms(dir)`. To support `--as-of`, we need a variant that runs against a pre-built atom list (atoms reconstructed by `replay()` for a past timestamp).

- [ ] **Step 7.1: Write the failing test (uses task-8 setup, so just stub for now)**

Append to a new file `test/wander-as-of.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initMemoryDir, createAtom, closeAllIndexes } from '../src/index.js';
import { wanderFromAtoms } from '../src/wander.js';
import type { Atom } from '../src/types.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-wander-asof-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('wanderFromAtoms', () => {
  it('runs spreading activation against a pre-built atom list', () => {
    const a = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'a', body: 'a',
      scope: { tags: ['shared-tag'] },
    });
    const b = createAtom({
      memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'b', body: 'b',
      scope: { tags: ['shared-tag'] },
    });
    const atoms: Atom[] = [a, b];

    const result = wanderFromAtoms(atoms, {
      memoryDir: testDir,
      seeds: [a.frontmatter.id],
      steps: 2,
    });

    expect(result.activated.length).toBeGreaterThanOrEqual(1);
    expect(result.seeds_used).toContain(a.frontmatter.id);
  });

  it('returns empty result when atom list is empty', () => {
    const result = wanderFromAtoms([], { memoryDir: testDir, seeds: ['MISSING'] });
    expect(result.activated).toEqual([]);
    expect(result.collisions).toEqual([]);
  });
});
```

- [ ] **Step 7.2: Run the test to verify it fails**

Run: `npx vitest run test/wander-as-of.test.ts -t "wanderFromAtoms"`
Expected: FAIL — function does not exist.

- [ ] **Step 7.3: Implement `wanderFromAtoms`**

In `src/wander.ts`, locate the `buildGraphFromFiles` function (around line 742). Add a new function immediately above it:

```typescript
/**
 * Build an in-memory graph from a pre-built atom array. Mirrors
 * buildGraphFromFiles but skips disk I/O. Used by wanderFromAtoms() to
 * support replay-aware queries (e.g. wander against state-as-of-T).
 *
 * Same filtering rules as buildGraphFromFiles: skips archived, expired,
 * conflict, SECRET, and PERSONAL atoms.
 */
function buildGraphFromAtomList(
  atoms: Atom[],
  now: number,
  options: WanderOptions,
): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();

  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id) continue;
    if (fm.status === 'archived' || fm.status === 'expired') continue;
    if (fm.type === 'conflict') continue;
    if (fm.classification === 'SECRET' || fm.classification === 'PERSONAL') continue;

    graph.set(fm.id, {
      tags: [...new Set(fm.scope?.tags ?? [])],
      type: fm.type,
      updated_at: fm.updated_at,
      base_activation: baseLevelActivation(fm.updated_at, now, 0),
      neighbors: new Map(),
      citation_count: 0,
    });
  }

  // Populate relation neighbors from frontmatter (bidirectional, strongest typed edge wins)
  const twLookup = options.typeWeights ?? DEFAULT_TYPE_WEIGHTS;
  for (const atom of atoms) {
    const fm = atom.frontmatter;
    if (!fm.id || !fm.relations) continue;
    const sourceNode = graph.get(fm.id);
    if (!sourceNode) continue;
    for (const rel of fm.relations) {
      const targetNode = graph.get(rel.target);
      if (!targetNode) continue;
      const relType = rel.type || 'related';
      const newWeight = twLookup[relType] ?? 0.3;

      const existingSrc = sourceNode.neighbors.get(rel.target);
      if (!existingSrc || newWeight > (twLookup[existingSrc] ?? 0.3)) {
        sourceNode.neighbors.set(rel.target, relType);
      }
      const existingTgt = targetNode.neighbors.get(fm.id);
      if (!existingTgt || newWeight > (twLookup[existingTgt] ?? 0.3)) {
        targetNode.neighbors.set(fm.id, relType);
      }
    }
  }

  return graph;
}

/**
 * Run spreading activation against a pre-built atom array.
 * No SQLite, no disk I/O — pure in-memory computation.
 *
 * Used by `mk wander --as-of <iso>` after reconstructing past state via replay().
 *
 * @example
 * ```ts
 * import { replayFromFile, wanderFromAtoms } from 'memory-kernel';
 * const result = replayFromFile('events.ndjson', { timestamp: '2026-04-15T00:00:00Z' });
 * const atoms = [...result.atoms.values()];
 * const wander = wanderFromAtoms(atoms, { memoryDir: dir, seeds: ['FACT-...'] });
 * ```
 */
export function wanderFromAtoms(atoms: Atom[], options: WanderOptions): WanderResult {
  const start = Date.now();

  if (atoms.length === 0) {
    return {
      collisions: [],
      activated: [],
      steps_taken: 0,
      duration_ms: Date.now() - start,
      seeds_used: [],
    };
  }

  const now = Date.now();
  const graph = buildGraphFromAtomList(atoms, now, options);
  return wanderWithGraph(graph, options, start);
}
```

Add `Atom` to the type imports at the top of `src/wander.ts`. Find the existing `import type` block and ensure it includes `Atom`:

```typescript
import type { Atom } from './types.js';
```

(If the import already exists with other types, just add `Atom` to the list.)

- [ ] **Step 7.4: Add export to `src/index.ts`**

In `src/index.ts`, find the wander barrel exports and add `wanderFromAtoms` alongside `wanderFromFiles`:

```typescript
export { wander, wanderFromFiles, wanderFromAtoms, WEIGHT_PRESETS } from './wander.js';
```

- [ ] **Step 7.5: Run the test to verify it passes**

Run: `npx vitest run test/wander-as-of.test.ts -t "wanderFromAtoms"`
Expected: 2 PASS.

- [ ] **Step 7.6: Run full suite**

Run: `npm test`
Expected: all tests pass; +2.

- [ ] **Step 7.7: Commit**

```bash
git add src/wander.ts src/index.ts test/wander-as-of.test.ts
git commit -m "$(cat <<'EOF'
feat(wander): add wanderFromAtoms() for replay-aware queries

New variant that runs spreading activation against a pre-built atom array
instead of reading files or the SQLite index. Enables mk wander --as-of
<iso> by replaying events to a past timestamp, then wandering against
the reconstructed atom set.

No I/O performed — pure in-memory. Same filtering rules as wanderFromFiles
(skips archived, expired, conflict, SECRET, PERSONAL).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `mk wander --as-of <iso>` flag + determinism test

**Files:**
- Modify: `src/cli/mk.ts:941-1050` (mk wander command)
- Modify: `test/wander-as-of.test.ts` (add CLI integration tests)

- [ ] **Step 8.1: Write the failing determinism test**

Append to `test/wander-as-of.test.ts`:

```typescript
import { execFileSync } from 'child_process';

const MK_BIN = path.resolve('dist/cli/mk.js');

describe('mk wander --as-of', () => {
  it('returns identical results across runs (determinism)', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // Build a small history
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'history-1', body: 'one', scope: { tags: ['t'] } });
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'history-2', body: 'two', scope: { tags: ['t'] } });

    const asOf = new Date(Date.now() + 60_000).toISOString(); // future, includes all events

    const out1 = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', asOf, '--json', '--steps', '2'], { encoding: 'utf-8' });
    const out2 = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', asOf, '--json', '--steps', '2'], { encoding: 'utf-8' });

    const r1 = JSON.parse(out1);
    const r2 = JSON.parse(out2);

    // duration_ms varies; everything else must match
    delete r1.duration_ms;
    delete r2.duration_ms;
    expect(r1).toEqual(r2);
  });

  it('excludes atoms not yet created at the as-of timestamp', () => {
    if (!fs.existsSync(MK_BIN)) return;

    // Atoms created now
    createAtom({ memoryDir: testDir, agent_id: 'a', session_id: 's',
      type: 'fact', slug: 'modern', body: 'modern' });

    // Use an as-of time that's BEFORE the events.ndjson file's first event
    const ancient = '2020-01-01T00:00:00Z';
    const out = execFileSync('node', [MK_BIN, 'wander', '-d', testDir, '--as-of', ancient, '--json'], { encoding: 'utf-8' });
    const r = JSON.parse(out);

    expect(r.activated).toEqual([]);
  });
});
```

- [ ] **Step 8.2: Run the test to verify it fails**

Run: `npm run build && npx vitest run test/wander-as-of.test.ts -t "mk wander --as-of"`
Expected: FAIL — `--as-of` flag is not registered.

- [ ] **Step 8.3: Add `--as-of` to `mk wander` command**

In `src/cli/mk.ts`, locate the `// --- mk wander ---` block (around line 939). Make these edits:

1. Add the new option among the existing `.option()` calls (alphabetical position is fine):

```typescript
  .option('--as-of <iso>', 'Run wander against state reconstructed as of this ISO8601 timestamp')
```

2. Add `asOf?: string` to the `opts` destructured type:

```typescript
  .action((opts: {
    dir: string;
    seed?: string[];
    tags?: string[];
    steps?: number;
    threshold?: number;
    topK?: number;
    decay?: number;
    maxCollisions?: number;
    relationWeight?: number;
    typeWeights?: string;
    weightPreset?: string;
    asOf?: string;
    json?: boolean;
  }) => {
```

3. Replace the existing wander invocation block (the `const wanderFn = useFiles ? wanderFromFiles : wander; const result = wanderFn({ ... })`) with this branching version:

```typescript
    let result;
    if (opts.asOf) {
      // Validate timestamp
      const asOfMs = new Date(opts.asOf).getTime();
      if (Number.isNaN(asOfMs)) {
        exitWithError(`Invalid --as-of timestamp: ${opts.asOf}`, opts.json);
      }

      // Replay events up to the timestamp to reconstruct atoms-as-of-T
      const eventsFile = path.join(memoryDir, 'events.ndjson');
      if (!fs.existsSync(eventsFile)) {
        exitWithError(`No events.ndjson at ${memoryDir}`, opts.json);
      }
      const replayResult = replayFromFile(eventsFile, {
        evidenceDir: path.join(memoryDir, 'evidence'),
      });
      // Filter atoms whose updated_at is at or before --as-of
      const atomsAsOf = [...replayResult.atoms.values()].filter(
        (a) => a.frontmatter.updated_at <= opts.asOf!,
      );
      result = wanderFromAtoms(atomsAsOf, {
        memoryDir,
        sharedMemoryDir,
        baseDir: sharedMemoryDir ? baseResolvedDir : undefined,
        seeds: opts.seed,
        seedTags: opts.tags,
        steps: opts.steps,
        threshold: opts.threshold,
        topK: opts.topK,
        decay: opts.decay,
        maxCollisions: opts.maxCollisions,
        relationWeight: opts.relationWeight,
        typeWeights,
      });
    } else {
      const wanderFn = useFiles ? wanderFromFiles : wander;
      result = wanderFn({
        memoryDir,
        sharedMemoryDir,
        baseDir: sharedMemoryDir ? baseResolvedDir : undefined,
        seeds: opts.seed,
        seedTags: opts.tags,
        steps: opts.steps,
        threshold: opts.threshold,
        topK: opts.topK,
        decay: opts.decay,
        maxCollisions: opts.maxCollisions,
        relationWeight: opts.relationWeight,
        typeWeights,
      });
    }
```

4. Update the imports at the top of `src/cli/mk.ts`:

```typescript
import { wander, wanderFromFiles, wanderFromAtoms, WEIGHT_PRESETS } from '../wander.js';
import { replayFromFile } from '../replay.js';
```

(`replayFromFile` may already be imported — confirm before duplicating.)

- [ ] **Step 8.4: Build and run the test**

Run: `npm run build && npx vitest run test/wander-as-of.test.ts -t "mk wander --as-of"`
Expected: 2 PASS.

- [ ] **Step 8.5: Run the full suite**

Run: `npm test`
Expected: all pass; total ≥ original + 6 (across timeline + relations + format-relations + wander-as-of new tests).

- [ ] **Step 8.6: Commit**

```bash
git add src/cli/mk.ts test/wander-as-of.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add --as-of flag to mk wander

Reconstructs past state via replayFromFile() then runs wanderFromAtoms()
against the atom set whose updated_at is at or before the timestamp.
Enables 'wander × time' interaction in the obsidian-mk-graph plugin —
running wander against state-as-of-playhead instead of always 'now'.

Refs docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md §4.3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Version bump (1.16.0 → 1.17.0) + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/openclaw-memory-kernel/package.json`
- Modify: `CHANGELOG.md`

Per CLAUDE.md, this single commit bumps all five places in lockstep. The git tag is created at release time, not in this commit.

- [ ] **Step 9.1: Bump `package.json`**

Replace `"version": "1.16.0"` with `"version": "1.17.0"`.

- [ ] **Step 9.2: Regenerate `package-lock.json`**

Run: `npm install --package-lock-only`
Expected: top-level `"version"` and the self-entry under `"packages": { "": { "version": ... } }` both updated to `1.17.0`.

- [ ] **Step 9.3: Bump openclaw plugin pin**

In `packages/openclaw-memory-kernel/package.json`, find the `"memory-kernel": "^1.16.0"` dependency entry and replace with `"memory-kernel": "^1.17.0"`.

- [ ] **Step 9.4: Update `CHANGELOG.md`**

Open `CHANGELOG.md`. Replace the existing `## [Unreleased]` heading with `## [1.17.0] — 2026-04-29`. If there are unrelated `[Unreleased]` items, leave them in place above the new section under a fresh `## [Unreleased]` heading. Add a new section to the 1.17.0 block:

```markdown
## [1.17.0] — 2026-04-29

### Added — visualization plugin foundations (Phase 1 of obsidian-mk-graph)

- **`Relation` schema extension.** Five new optional fields on every relation: `created_at` (ISO8601, when the edge was created), `confidence` (0..1, belief in the relation), `weight` (per-edge wander weight, overrides type default), `source` (`'manual' | 'extracted' | 'enriched' | 'unknown'`, edge provenance), and `evidence` (string[] of supporting atom/episode/hash refs). All fields are optional; legacy `{target, type}` relations parse unchanged.
- **`mk timeline --json` CLI command.** Emits replay-ready event streams: snapshots inline, `atom_snapshot_hash` resolved via the evidence dir, SECRET atoms decrypted when `MEMORY_ENCRYPTION_KEY` is set (otherwise marked `redacted: true`), filtered by `--from <iso>` / `--to <iso>`. Used by the obsidian-mk-graph plugin's replay engine.
- **`mk wander --as-of <iso>` flag.** Runs spreading activation against state reconstructed via `replay()` to the specified timestamp instead of current state. Enables historical "what would the agent have surfaced then?" queries.
- **New library exports:** `getTimeline`, `wanderFromAtoms`, `applyProposals`, `RELATION_SOURCES`.
- **Write-time provenance.** `createAtom` auto-relink path now stamps extracted relations with `source='extracted'`; explicit caller-supplied relations default to `source='manual'`. `enrich-relations.ts` proposals carry `source='enriched'` and `confidence`.

### Behavior unchanged

- The PR #28 `LEGACY_TYPED_LINK_KEYS` stripper is retained — atoms serialised before Juggl support was removed continue to parse correctly. New fields live inside the `relations[]` array, not as top-level Juggl-style keys.
- SQLite `atom_relations` index schema is unchanged. Wander does not yet consume the new per-edge fields. (Out of scope for Phase 1.)
```

(If the file already has an `[Unreleased]` section with content unrelated to this work, preserve it. Move only items related to Phase 1 changes into `[1.17.0]`.)

- [ ] **Step 9.5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9.6: Confirm published-package contents are unchanged in shape**

Run: `npm pack --dry-run 2>&1 | head -40`
Expected: the listed files include `dist/`, `README.md`, `LICENSE` — no test files or specs leaked. Verify no surprises.

- [ ] **Step 9.7: Commit**

```bash
git add package.json package-lock.json packages/openclaw-memory-kernel/package.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore(release): v1.17.0 — Relation schema extension + mk timeline + wander --as-of

Phase 1 of the obsidian-mk-graph plugin work: ships mk-core changes that
unblock external visualization tools to read replay-ready event streams,
run wander against past state, and consume per-edge metadata (created_at,
confidence, weight, source, evidence).

Backward compatible: legacy {target, type} relations parse unchanged;
PR #28 LEGACY_TYPED_LINK_KEYS stripper retained.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9.8 (release-only, NOT part of this commit batch): tag**

When the user is ready to publish:

```bash
git tag v1.17.0
git push origin v1.17.0
```

Tagging is left to the user — do not auto-tag during plan execution.

---

## Self-review checklist

Before considering Phase 1 complete, verify:

- [ ] Spec §4.1 `Relation` extension — all 5 fields added in Tasks 1, 3, 4. ✓
- [ ] Spec §4.2 `mk timeline --json` — Tasks 5, 6. JSON shape matches "JSON document with `events` array". ✓
- [ ] Spec §4.3 `mk wander --as-of` — Tasks 7, 8. ✓
- [ ] Spec §7 testing strategy — TDD applied throughout; round-trip + LEGACY_TYPED_LINK_KEYS regression in Task 2; determinism test in Task 8. ✓
- [ ] PR #28 alignment risk (Spec §8) — Task 2 specifically locks in `LEGACY_TYPED_LINK_KEYS` behavior. ✓
- [ ] CLAUDE.md versioning — five-place bump in Task 9 matches the convention. ✓
- [ ] No SQLite schema changes (out of scope confirmed in plan header). ✓
- [ ] No plugin code (Phase 2+). ✓
- [ ] Each task is TDD: failing test → implement → passing test → commit. ✓
- [ ] No "TBD"/"TODO"/"add appropriate handling" placeholders. ✓
- [ ] Function signatures consistent across tasks (`getTimeline`, `wanderFromAtoms`, `applyProposals`). ✓
- [ ] CHANGELOG entry exists for every public-API addition. ✓

If a checklist item is unverified, fix it inline before proceeding.

---

## What this plan does NOT cover

- Phase 2: Obsidian plugin scaffold (`packages/obsidian-mk-graph/`, manifest, settings UI, force layout, F2 encoding).
- Phase 3: Replay engine + timeline scrubber UI in the plugin.
- Phase 4: Wander visualization layers (heatmap, ripple, constellation, radial-wander layout).
- Phase 5: F3 togglable layers, performance hardening at 10k atoms, BRAT release, Community Plugins submission.
- SQLite `atom_relations` table changes (deferred until wander or recall consume the new fields).
- Plugin manifest version conventions (covered in Phase 5 plan when packaging starts).

Each subsequent phase will be specified in its own writing-plans session and reference this Phase 1 work as a prerequisite.
