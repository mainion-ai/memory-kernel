/**
 * orphan-prose-refs check — flags atoms whose BODY prose references another
 * atom by ID (e.g. "Extends BELI-2026-…") where that atom exists in the store
 * but the reference is NOT wired as a formal `frontmatter.relations[].target`
 * (#243).
 *
 * These create disconnected islands in the atom graph: logically connected in
 * human-readable prose, invisible to graph traversal / Obsidian because the
 * edge lives only in text, not in `relations[]`. Distinct from the
 * `atom-frontmatter` `broken-relation-ref` check, which catches the inverse —
 * a *formal* relation whose target does not exist.
 *
 * Scans all non-archived atoms (`listAtoms` = ENTITIES + CONFLICTS). The
 * referenced ID must exist in the store (ENTITIES + CONFLICTS + ARCHIVE, plus
 * the shared namespace in per-agent mode — via the shared `buildAllIds`) so a
 * dead/typo'd ref is not mistaken for an unwired one. Detection only:
 * inferring the correct relation type from prose is ambiguous, so no `fix()`
 * in v1 — the operator wires the relation manually.
 */

import { listAtoms } from '../../index.js';
import { RELATION_TYPES } from '../../types.js';
import { buildAllIds } from './atom-frontmatter.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

// Atom-ID prefixes a prose reference may use. Per #243 scope; CONS/PROC/ENTS/
// CONF are intentionally out (trivial to add if prose refs to them appear).
const ID_PREFIXES = ['BELI', 'FACT', 'DECI', 'PREF', 'OPEN'];

// "<relation-word> <ATOM-ID>" — e.g. "Extends BELI-2026-05-24-foo-1abcd".
// Relation words are the canonical RELATION_TYPES; matched case-insensitively
// (prose writes "Extends" or "extends"). The ID character class includes
// lowercase because atom IDs carry a lowercase suffix (…-1abcd).
//
// This deliberately does NOT fire on the machine-generated `<!-- mk:relations -->`
// section, whose lines are `- <type> [[<id>]]`: the `\s+` after the relation
// word cannot span the `[[` wiki-link opener, so a correctly-rendered relations
// section never trips this check — no false positives from formalised edges.
const PROSE_REF_RE = new RegExp(
  `\\b(${RELATION_TYPES.join('|')})\\s+((?:${ID_PREFIXES.join('|')})-[A-Za-z0-9-]+)`,
  'gi',
);

export const orphanProseRefsCheck: Check = {
  name: 'orphan-prose-refs',
  category: 'memory',
  defaultSeverity: 'warn',

  run(ctx: DoctorContext): CheckResult {
    const atoms = listAtoms(ctx.memoryDir);
    const allIds = buildAllIds(ctx.memoryDir);
    const issues: string[] = [];

    for (const atom of atoms) {
      const id = (atom.frontmatter.id as string | undefined) ?? '<no-id>';
      const formalTargets = new Set(
        (atom.frontmatter.relations ?? []).map((r) => r.target),
      );

      // Dedupe key is `relWord:target` (not just `target`) on purpose: if prose
      // names the same orphaned target under two different relation words
      // ("extends B" and "supports B"), surface both so the operator sees which
      // relation type(s) to wire. Repeated identical mentions still collapse.
      const seen = new Set<string>();
      for (const m of atom.body.matchAll(PROSE_REF_RE)) {
        const relWord = m[1].toLowerCase();
        const target = m[2];
        const key = `${relWord}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (target === id) continue; // self-reference is noise, not an edge
        if (!allIds.has(target)) continue; // dead/typo ref — out of scope here
        if (formalTargets.has(target)) continue; // already wired

        issues.push(
          `orphan-prose-ref: ${id} — body references ${target} (${relWord}) ` +
            `but it has no matching frontmatter.relations[] entry`,
        );
      }
    }

    return {
      name: orphanProseRefsCheck.name,
      category: orphanProseRefsCheck.category,
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
};
