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
