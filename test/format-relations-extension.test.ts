import { describe, it, expect } from 'vitest';
import { parseAtom, serializeAtom } from '../src/format.js';
import { validateAtomFrontmatter } from '../src/schema.js';
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

describe('Relation weight bounds', () => {
  const baseFrontmatter = {
    id: 'FACT-2026-04-29-WEIGHT-aa00',
    type: 'fact',
    status: 'active',
    confidence: 0.9,
    created_at: '2026-04-29T10:00:00Z',
    updated_at: '2026-04-29T10:00:00Z',
    ttl_days: null,
  };

  const withWeight = (weight: number) => ({
    ...baseFrontmatter,
    relations: [{ target: 'FACT-2026-04-28-OTHER-bb01', type: 'extends', weight }],
  });

  it('rejects a relation with negative weight', () => {
    const result = validateAtomFrontmatter(withWeight(-1));
    expect(result.success).toBe(false);
  });

  it('rejects a relation with weight > 10', () => {
    const result = validateAtomFrontmatter(withWeight(99));
    expect(result.success).toBe(false);
  });

  it('accepts boundary values 0 and 10', () => {
    expect(validateAtomFrontmatter(withWeight(0)).success).toBe(true);
    expect(validateAtomFrontmatter(withWeight(10)).success).toBe(true);
  });
});
