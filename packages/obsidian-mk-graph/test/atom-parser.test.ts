import { describe, it, expect } from 'vitest';
import { parseAtomFile } from '../src/atom-parser.js';

describe('parseAtomFile', () => {
  it('parses a fully-populated atom with extended relations', () => {
    const md = `---
id: FACT-2026-04-29-EXAMPLE-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
classification: TEAM
scope:
  tags: [demo, sample]
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: extends
    confidence: 0.85
    weight: 1.6
    source: manual
---

Body content here.
`;
    const atom = parseAtomFile(md, '/vault/.mk/ENTITIES/FACT-2026-04-29-EXAMPLE-aa00.md');
    expect(atom).not.toBeNull();
    expect(atom!.id).toBe('FACT-2026-04-29-EXAMPLE-aa00');
    expect(atom!.type).toBe('fact');
    expect(atom!.status).toBe('active');
    expect(atom!.classification).toBe('TEAM');
    expect(atom!.tags).toEqual(['demo', 'sample']);
    expect(atom!.createdAt).toBe('2026-04-29T10:00:00Z');
    expect(atom!.relations).toHaveLength(1);
    expect(atom!.relations[0]).toEqual({
      target: 'FACT-2026-04-28-OTHER-bb01',
      type: 'extends',
      confidence: 0.85,
      weight: 1.6,
      source: 'manual',
    });
    expect(atom!.body).toContain('Body content here.');
    expect(atom!.filePath).toBe('/vault/.mk/ENTITIES/FACT-2026-04-29-EXAMPLE-aa00.md');
  });

  it('parses a legacy {target,type}-only relation', () => {
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
    type: supports
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.relations[0]).toEqual({
      target: 'FACT-2026-04-28-OTHER-bb01',
      type: 'supports',
    });
  });

  it('defaults missing optional fields gracefully', () => {
    const md = `---
id: BELI-2026-04-29-MIN-aa00
type: belief
status: active
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.classification).toBe('TEAM'); // F2 default per spec §5.2
    expect(atom!.tags).toEqual([]);
    expect(atom!.relations).toEqual([]);
  });

  it('returns null for missing required fields (id/type/status) instead of throwing', () => {
    const md = `---
type: fact
status: active
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('returns null for malformed YAML instead of throwing', () => {
    const md = `---
id: [this: is: not: valid
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('strips the `## Relations` body section if present', () => {
    const md = `---
id: FACT-2026-04-29-RELS-aa00
type: fact
status: active
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
---

Real body content.

## Relations

- [[FACT-2026-04-28-OTHER-bb01]] (extends)
`;
    const atom = parseAtomFile(md);
    expect(atom!.body.trim()).toBe('Real body content.');
  });
});
