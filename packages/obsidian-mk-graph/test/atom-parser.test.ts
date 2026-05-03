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

  it('defaults missing optional fields gracefully (id/type/status only)', () => {
    const md = `---
id: BELI-2026-04-29-MIN-aa00
type: belief
status: active
---

Body content.
`;
    const atom = parseAtomFile(md);
    expect(atom).not.toBeNull();
    expect(atom!.classification).toBe('TEAM'); // F2 default per spec §5.2
    expect(atom!.tags).toEqual([]);
    expect(atom!.relations).toEqual([]);
    expect(atom!.confidence).toBe(1.0);
    expect(atom!.ttlDays).toBeNull();
    expect(atom!.createdAt).toBe('');
    expect(atom!.updatedAt).toBe('');
    expect(atom!.body.trim()).toBe('Body content.');
  });

  it('preserves numeric ttl_days', () => {
    const md = `---
id: FACT-2026-04-29-TTL-aa00
type: fact
status: active
ttl_days: 30
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.ttlDays).toBe(30);
  });

  it('returns null when `id` is missing', () => {
    const md = `---
type: fact
status: active
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('returns null when `type` is missing', () => {
    const md = `---
id: FACT-2026-04-29-NOTYPE-aa00
status: active
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('returns null when `status` is missing', () => {
    const md = `---
id: FACT-2026-04-29-NOSTATUS-aa00
type: fact
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

  it('strips the `## Relations` section delimited by the mk-core sentinel comment', () => {
    const md = `---
id: FACT-2026-04-29-SENTINEL-aa00
type: fact
status: active
---

Real body content.

<!-- mk:relations -->
## Relations

- [[FACT-2026-04-28-OTHER-bb01]] (extends)
`;
    const atom = parseAtomFile(md);
    expect(atom!.body).not.toContain('<!-- mk:relations -->');
    expect(atom!.body).not.toContain('## Relations');
    expect(atom!.body.trim()).toBe('Real body content.');
  });

  it('normalizes comma-separated tags into individual entries', () => {
    // Older mk CLI versions wrote `--tags "a,b,c"` as a single string;
    // mirror mk-core's normalizeTags (src/format.ts) so legacy stores
    // render as three tags instead of one.
    const md = `---
id: FACT-2026-04-29-COMMATAGS-aa00
type: fact
status: active
scope:
  tags: ["alpha,beta", "gamma", " beta ", "alpha"]
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('drops relations whose target or type is not a string', () => {
    const md = `---
id: FACT-2026-04-29-BAD-aa00
type: fact
status: active
relations:
  - target: 12345
    type: extends
  - target: FACT-2026-04-28-OK-bb01
    type: 7
  - target: FACT-2026-04-28-KEEP-cc02
    type: supports
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.relations).toEqual([
      { target: 'FACT-2026-04-28-KEEP-cc02', type: 'supports' },
    ]);
  });
});
