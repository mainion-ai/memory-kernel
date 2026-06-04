/**
 * links check — flags references in atom frontmatter (links.related,
 * links.supersedes, links.blocked_by) that point at non-existent atoms.
 * Extracted from inline `mk doctor` logic (#140).
 */

import { listAtoms } from '../../index.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

export const linksCheck: Check = {
  name: 'broken-links',
  category: 'memory',
  defaultSeverity: 'warn',
  run(ctx: DoctorContext): CheckResult {
    const atoms = listAtoms(ctx.memoryDir);
    const ids = new Set(atoms.map((a) => a.frontmatter.id));
    const issues: string[] = [];
    for (const atom of atoms) {
      const linked = [
        ...(atom.frontmatter.links?.related ?? []),
        ...(atom.frontmatter.links?.supersedes ?? []),
        ...(atom.frontmatter.links?.blocked_by ?? []),
      ];
      for (const target of linked) {
        if (!ids.has(target)) {
          issues.push(`${atom.frontmatter.id} → ${target}`);
        }
      }
    }
    return {
      name: linksCheck.name,
      category: linksCheck.category,
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
};
