/**
 * Minimal YAML-frontmatter parser. Replaces the `gray-matter` dependency
 * (#176) — that package is unmaintained upstream and pulls in `js-yaml@3.x`
 * transitively, while the rest of the project uses `js-yaml@4.x` directly.
 *
 * Surface matches the subset of gray-matter that `src/format.ts` and
 * `src/episodes.ts` actually call:
 *
 *     parseFrontmatter(raw) === { data: Record<string, unknown>, content: string }
 *
 * Behaviour matches gray-matter for the well-formed inputs every current
 * caller produces — `serializeAtom()` and `writeEpisode()` always emit a
 * balanced `---\n…\n---\n` block. Specifically:
 *   - Opening fence must be `---` at position 0 (after BOM strip). No leading
 *     whitespace allowed — matches gray-matter's strict prefix check.
 *   - Closing fence is `---` on its own line.
 *   - Empty frontmatter (`---\n---\n`) yields `{ data: {}, content: ... }`.
 *   - Invalid YAML throws (propagated from `yaml.load`).
 *   - CRLF line endings are recognised; the body slice preserves whatever
 *     line endings the source used.
 *
 * Two intentional departures from gray-matter, both for malformed inputs
 * that should never appear in a healthy store:
 *   - Missing closing fence: gray-matter scans to EOF and tries to parse
 *     the remainder as YAML (which usually throws). The splitter falls
 *     through silently and returns `{ data: {}, content: raw }`. Observably
 *     equivalent at every caller — `parseAtom()` still rejects via its
 *     required-field check (the missing `id`/`type`/`status` surface as a
 *     stderr warning in `listAtoms` per #100), and episode readers wrap the
 *     parser in try/catch.
 *   - Non-mapping frontmatter (a bare YAML scalar or array between the
 *     fences): gray-matter returns it as `data`. The splitter throws,
 *     mirroring what every downstream Zod schema would do anyway.
 *
 * Out of scope (gray-matter features we deliberately do not implement):
 *   - Custom fence delimiters, TOML/JSON frontmatter, language tags
 *     (`---toml`), excerpts, custom engines. We only consume default YAML.
 */

import yaml from 'js-yaml';

const FENCE = '---';

/**
 * Return type mirrors `gray-matter`'s `{ data, content }` shape.
 *
 * `data` is intentionally typed permissively (`Record<string, any>`) — every
 * caller drives schema validation downstream via Zod (`AtomFrontmatterSchema`)
 * or runtime `typeof` checks, so the parser stays out of the typing decision.
 * This matches gray-matter's own typings and keeps the surface drop-in.
 */
export interface ParsedFrontmatter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: { [key: string]: any };
  content: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // Strip UTF-8 BOM if present (gray-matter does this via strip-bom). The
  // stripped string is what every subsequent slice — including the no-fence
  // and missing-close-fence fallthrough returns — operates on, so BOM never
  // surfaces in `content`. Matches gray-matter's contract.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  if (!text.startsWith(FENCE)) {
    return { data: {}, content: text };
  }

  // The opening `---` must be followed by an end-of-line so we don't treat
  // a string like `---foo` (e.g. a heading delimiter) as a fence.
  const afterFence = text.charAt(FENCE.length);
  if (afterFence !== '' && afterFence !== '\n' && afterFence !== '\r') {
    return { data: {}, content: text };
  }

  // Skip past the opening fence line.
  let cursor = FENCE.length;
  while (cursor < text.length && text[cursor] !== '\n') cursor++;
  cursor++; // step over the `\n`
  const bodyStart = cursor;

  // Scan line-by-line for the closing fence.
  let closingFenceStart = -1;
  let closingFenceEnd = -1;
  let lineStart = bodyStart;
  while (lineStart < text.length) {
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd++;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (line === FENCE) {
      closingFenceStart = lineStart;
      // Consume the trailing `\n` of the fence line so the returned content
      // starts on the next character (matches gray-matter's slice math).
      closingFenceEnd = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      break;
    }
    lineStart = lineEnd + 1;
  }

  if (closingFenceStart === -1) {
    // Opening fence but no closing — gray-matter returns the input unchanged.
    return { data: {}, content: text };
  }

  const yamlText = text.slice(bodyStart, closingFenceStart);
  const contentText = text.slice(closingFenceEnd);

  let data: ParsedFrontmatter['data'];
  if (yamlText.trim() === '') {
    data = {};
  } else {
    const parsed = yaml.load(yamlText);
    if (parsed === null || parsed === undefined) {
      data = {};
    } else if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Frontmatter must be a YAML mapping, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    } else {
      data = parsed as ParsedFrontmatter['data'];
    }
  }

  return { data, content: contentText };
}
