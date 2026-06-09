/**
 * atom-frontmatter check — validates referential integrity and id/filename
 * consistency of atom frontmatter (#227).
 *
 * Errors (ok=false, severity='error'):
 *   - relations[].target references a non-existent atom ID
 *   - frontmatter.id does not match the filename (sans .md)
 *   - duplicate atom IDs within ENTITIES/ and CONFLICTS/
 *
 * Section/frontmatter drift (stale <!-- mk:relations --> content) is a
 * separate, warn-only concern handled by the atom-relations-section check.
 *
 * No `fix()` — all issues require human review.
 */

import fs from 'fs';
import path from 'path';
import { listAtoms } from '../../index.js';
import { getSharedDir } from '../../isolation.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

/** Directories that contribute valid atom IDs for broken-ref resolution. */
const REF_DIRS = ['ENTITIES', 'CONFLICTS', 'ARCHIVE'];

/**
 * Build the complete set of known atom IDs by scanning filenames in all
 * atom-bearing directories. Using filenames (not parsing) avoids false
 * positives from corrupt atoms that listAtoms() skips.
 *
 * In per-agent isolation mode the resolved memoryDir is `baseDir/agents/<id>`,
 * but relations may legitimately target atoms in the shared namespace
 * (`baseDir/shared`) surfaced by union recall. Scan it too so a valid
 * agent→shared edge is not reported as a broken-relation-ref. Widening the
 * known-ID set can only suppress false positives — it never creates new ones.
 */
function buildAllIds(memoryDir: string): Set<string> {
  const roots = [memoryDir];
  if (path.basename(path.dirname(memoryDir)) === 'agents') {
    roots.push(getSharedDir(path.dirname(path.dirname(memoryDir))));
  }

  const ids = new Set<string>();
  for (const root of roots) {
    for (const dir of REF_DIRS) {
      const dirPath = path.join(root, dir);
      if (!fs.existsSync(dirPath)) continue;
      for (const f of fs.readdirSync(dirPath)) {
        if (f.endsWith('.md')) {
          ids.add(f.slice(0, -3));
        }
      }
    }
  }
  return ids;
}

export const atomFrontmatterCheck: Check = {
  name: 'atom-frontmatter',
  category: 'memory',
  defaultSeverity: 'error',

  run(ctx: DoctorContext): CheckResult {
    const atoms = listAtoms(ctx.memoryDir);
    const allIds = buildAllIds(ctx.memoryDir);
    const errors: string[] = [];
    const seenIds = new Map<string, string>(); // id → first filePath

    for (const atom of atoms) {
      const id = (atom.frontmatter.id as string | undefined) ?? '<no-id>';
      const filePath = atom.filePath ?? '';
      const relations: Array<{ target?: string; type?: string }> = atom.frontmatter.relations ?? [];

      // Error: filename ≠ frontmatter id
      if (filePath) {
        const basename = path.basename(filePath, '.md');
        if (basename !== id) {
          errors.push(`id-mismatch: filename "${basename}" ≠ frontmatter id "${id}" in ${filePath}`);
        }
      }

      // Error: duplicate id
      if (seenIds.has(id)) {
        errors.push(`duplicate-id: "${id}" appears in ${filePath} and ${seenIds.get(id)}`);
      } else {
        seenIds.set(id, filePath);
      }

      // Error: broken relations[].target ref
      for (const rel of relations) {
        if (rel.target && !allIds.has(rel.target)) {
          errors.push(`broken-relation-ref: ${id} → ${rel.target}`);
        }
      }
    }

    return {
      name: atomFrontmatterCheck.name,
      category: atomFrontmatterCheck.category,
      severity: 'error',
      ok: errors.length === 0,
      issues: errors.map((e) => `error: ${e}`),
    };
  },
};
