/**
 * conflicts check — surfaces active conflict atoms so the user can resolve
 * them. Extracted from inline `mk doctor` logic (#140).
 */

import { listAtoms } from '../../index.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

export const conflictsCheck: Check = {
  name: 'active-conflicts',
  category: 'memory',
  defaultSeverity: 'warn',
  run(ctx: DoctorContext): CheckResult {
    const atoms = listAtoms(ctx.memoryDir);
    const issues = atoms
      .filter(
        (a) =>
          a.frontmatter.type === 'conflict' && a.frontmatter.status === 'active',
      )
      .map((a) => a.frontmatter.id);
    return {
      name: conflictsCheck.name,
      category: conflictsCheck.category,
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
};
