/**
 * Direct unit tests for the internal frontmatter splitter (#176).
 *
 * The integration is exercised by the atom round-trip suite; these tests
 * cover the edge cases that previously came for free with gray-matter.
 */

import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/internal/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses a basic atom-shaped document', () => {
    const raw = `---
id: FACT-2026-05-25-EXAMPLE-aa
type: fact
status: active
---

Body text here.
`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.id).toBe('FACT-2026-05-25-EXAMPLE-aa');
    expect(data.type).toBe('fact');
    expect(data.status).toBe('active');
    expect(content.trim()).toBe('Body text here.');
  });

  it('returns empty data and original content when no opening fence', () => {
    const raw = 'just some plain markdown\nno frontmatter here';
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  it('handles empty input', () => {
    const { data, content } = parseFrontmatter('');
    expect(data).toEqual({});
    expect(content).toBe('');
  });

  it('handles empty frontmatter block', () => {
    const raw = `---
---
body
`;
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe('body\n');
  });

  it('preserves a body that itself contains a --- separator', () => {
    const raw = `---
id: foo
---

before
---
after
`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.id).toBe('foo');
    // The second `---` inside the body must not be treated as frontmatter.
    expect(content).toContain('before');
    expect(content).toContain('after');
    expect(content).toContain('---');
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\nid: bar\r\nstatus: active\r\n---\r\nbody\r\n';
    const { data, content } = parseFrontmatter(raw);
    expect(data.id).toBe('bar');
    expect(data.status).toBe('active');
    expect(content.trim()).toBe('body');
  });

  it('strips a leading UTF-8 BOM before fence detection', () => {
    const raw = '﻿---\nid: baz\n---\nbody\n';
    const { data } = parseFrontmatter(raw);
    expect(data.id).toBe('baz');
  });

  it('strips a leading BOM even on the no-fence fallthrough', () => {
    // gray-matter strips BOM unconditionally; ensure the fallthrough path
    // does too so `content` never carries a leaked BOM into downstream
    // string handling.
    const raw = '﻿plain markdown, no frontmatter';
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe('plain markdown, no frontmatter');
    expect(content.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('falls through to no-frontmatter when the opening --- has no terminating newline', () => {
    // Heading-style: `--- some title` should not be misread as a fence.
    const raw = '---foo: not yaml\n';
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  it('returns the raw input when there is no closing fence', () => {
    const raw = `---
id: nofence
status: active

body never closed
`;
    const { data, content } = parseFrontmatter(raw);
    // Intentional departure from gray-matter (which would throw a
    // YAMLException after scanning to EOF). The splitter falls through
    // silently — observably equivalent at every caller because parseAtom()
    // still rejects via its required-field check (`Missing or invalid 'id'`)
    // and episode readers wrap the parser in try/catch.
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  it('throws on invalid YAML', () => {
    const raw = `---
id: oops
status: [unterminated
---
body
`;
    expect(() => parseFrontmatter(raw)).toThrow();
  });

  it('throws when frontmatter is a YAML scalar (e.g. just a string), not a mapping', () => {
    const raw = `---
just a string
---
body
`;
    expect(() => parseFrontmatter(raw)).toThrow(/mapping/);
  });

  it('throws when frontmatter is a YAML array, not a mapping', () => {
    const raw = `---
- item1
- item2
---
body
`;
    expect(() => parseFrontmatter(raw)).toThrow(/array/);
  });

  it('preserves nested structures in frontmatter', () => {
    const raw = `---
id: nested
type: fact
status: active
scope:
  tags:
    - alpha
    - beta
relations:
  - type: extends
    target: FACT-2026-01-01-X-aa
---
body
`;
    const { data } = parseFrontmatter(raw);
    const scope = data.scope as { tags: string[] };
    expect(scope.tags).toEqual(['alpha', 'beta']);
    const rels = data.relations as Array<{ type: string; target: string }>;
    expect(rels[0]?.type).toBe('extends');
    expect(rels[0]?.target).toBe('FACT-2026-01-01-X-aa');
  });
});
