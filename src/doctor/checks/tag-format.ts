/**
 * tag-format check (#262) — flags atoms with malformed tags (whitespace in a
 * tag token). Tags in the mk convention are single hyphen-separated tokens; a
 * space-joined string emitted as one YAML list item is valid YAML but one
 * opaque token that breaks FTS tag queries and tag filtering. Parsing succeeds
 * silently, so nothing else catches it.
 *
 * Warn-only and not auto-fixable: splitting `"a b c"` into `[a, b, c]` is
 * ambiguous (could be one intentional multi-word concept), so it needs human
 * review. Shares the `isValidTag` predicate with `mk remember`'s write-time
 * warning.
 */
import { listAtoms } from '../../store.js';
import { isValidTag } from '../../format.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

export const tagFormatCheck: Check = {
  name: 'tag-format',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    const issues: string[] = [];
    for (const atom of listAtoms(ctx.memoryDir)) {
      const tags = atom.frontmatter.scope?.tags;
      if (!tags) continue;
      for (const tag of tags) {
        if (!isValidTag(tag)) {
          issues.push(`tag-format: ${atom.frontmatter.id} — tag contains whitespace: "${tag}"`);
        }
      }
    }
    return {
      name: 'tag-format',
      category: 'memory',
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
};
