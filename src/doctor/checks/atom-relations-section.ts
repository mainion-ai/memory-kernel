/**
 * atom-relations-section check — warns when a <!-- mk:relations --> section
 * is present but out of sync with frontmatter.relations[] (#227).
 *
 * Warnings (ok=false, severity='warn'):
 *   - section exists but is missing an outgoing edge that is listed in
 *     frontmatter.relations[] (section was not regenerated after a manual
 *     frontmatter edit, or mk relate was not re-run)
 *
 * Incoming/reverse edges in the section (e.g. extended-by, referenced-by)
 * are intentionally ignored — they are managed by the other end of the edge
 * and are not in frontmatter.relations[].
 *
 * Separated from atom-frontmatter so that:
 *   - mk doctor human output counts/tags each severity correctly (the
 *     frontmatter check is error-only; this check is warn-only)
 *   - a future fix() can regenerate sections via renderRelationsSection
 *     without implying the integrity errors in atom-frontmatter are fixable
 *
 * No fix() yet — section regeneration requires a round-trip through
 * renderRelationsSection and a file write, which deserves its own PR.
 */

import fs from 'fs';
import { listAtoms } from '../../index.js';
import { RELATIONS_SENTINEL, parseRelationsSection } from '../../obsidian.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

export const atomRelationsSectionCheck: Check = {
  name: 'atom-relations-section',
  category: 'memory',
  defaultSeverity: 'warn',

  run(ctx: DoctorContext): CheckResult {
    const atoms = listAtoms(ctx.memoryDir);
    const warnings: string[] = [];

    for (const atom of atoms) {
      const id = (atom.frontmatter.id as string | undefined) ?? '<no-id>';
      const filePath = atom.filePath ?? '';
      const relations: Array<{ target?: string; type?: string }> = atom.frontmatter.relations ?? [];

      if (!filePath || relations.length === 0) continue;

      let rawContent: string | undefined;
      try {
        rawContent = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      if (!rawContent.includes(RELATIONS_SENTINEL)) continue;

      const sectionEdges = parseRelationsSection(rawContent);
      const sectionSet = new Set(sectionEdges.map((e) => `${e.type}:${e.target}`));
      for (const rel of relations) {
        if (rel.type && rel.target && !sectionSet.has(`${rel.type}:${rel.target}`)) {
          warnings.push(
            `stale-relations-section: ${id} — ` +
              `frontmatter has ${rel.type} → ${rel.target} but section missing it`,
          );
        }
      }
    }

    return {
      name: atomRelationsSectionCheck.name,
      category: atomRelationsSectionCheck.category,
      severity: 'warn',
      ok: warnings.length === 0,
      issues: warnings.map((w) => `warning: ${w}`),
    };
  },
};
