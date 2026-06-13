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
import { parseFrontmatter } from '../../internal/frontmatter.js';
import type { Check, CheckResult, DoctorContext } from '../types.js';

/** Directories that contribute valid atom IDs for broken-ref resolution. */
const REF_DIRS = ['ENTITIES', 'CONFLICTS', 'ARCHIVE'];

/**
 * Build the complete set of known atom IDs by scanning all atom-bearing
 * directories. Each file contributes BOTH its basename (sans `.md`) and its
 * authoritative frontmatter `id:` — registering the basename keeps corrupt
 * atoms (that listAtoms() skips) contributing something, while the frontmatter
 * id resolves files whose name has drifted from their id (legacy doubled
 * `<id>-<id>.md` archive files), which otherwise produced false
 * `broken-relation-ref` errors on inbound relations to the real id (#327).
 * Widening the known-ID set can only suppress false positives — never create new ones.
 *
 * In per-agent isolation mode the resolved memoryDir is `baseDir/agents/<id>`,
 * but relations may legitimately target atoms in the shared namespace
 * (`baseDir/shared`) surfaced by union recall. Scan it too so a valid
 * agent→shared edge is not reported as a broken-relation-ref. Widening the
 * known-ID set can only suppress false positives — it never creates new ones.
 */
/**
 * Read just the head of a file (enough to contain atom frontmatter) without
 * loading a potentially-large archived body into memory. If the closing `---`
 * fence is beyond `bytes`, parseFrontmatter sees no close fence and returns no
 * id — the basename fallback still applies, so this only trades a vanishingly
 * rare giant-frontmatter case for bounded I/O.
 */
function readHead(filePath: string, bytes = 8192): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function buildAllIds(memoryDir: string): Set<string> {
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
        if (!f.endsWith('.md')) continue;
        ids.add(f.slice(0, -3)); // basename — back-compat + keeps corrupt atoms contributing
        // Also register the authoritative frontmatter id (#327): a file whose
        // name drifted from its id still resolves inbound relations to its real id.
        // Read only the head (frontmatter is small) so a large archived body
        // doesn't add unbounded I/O to `mk doctor` on a big ARCHIVE.
        try {
          const id = parseFrontmatter(readHead(path.join(dirPath, f))).data?.id;
          if (typeof id === 'string' && id) ids.add(id);
        } catch {
          /* unreadable / malformed YAML — basename already added above */
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
