/**
 * Shared CLI helper for looking up an atom's file path by atom ID.
 *
 * Extracted from `relate.ts` and `supersede.ts` which had byte-identical
 * copies of the same logic (issue #70).
 */

import {
  listAtomFiles,
  readAtom,
  indexExists,
  openIndex,
} from '../index.js';

/**
 * Look up the on-disk file for an atom by ID. Index-first, with a
 * file-scan fallback if the index lookup fails or the atom isn't indexed.
 *
 * Failures during index access are surfaced on stderr (don't mask DB
 * corruption, ABI mismatches, or malformed atoms) but don't abort — a
 * degraded read path is better than a crash when the user is trying to
 * inspect or repair memory.
 *
 * Returns `null` when no atom with that ID is found.
 */
export function findAtomFile(memoryDir: string, atomId: string): string | null {
  if (indexExists(memoryDir)) {
    try {
      const db = openIndex(memoryDir);
      const row = db.prepare('SELECT file_path FROM atoms WHERE atom_id = ?').get(atomId) as
        | { file_path: string }
        | undefined;
      if (row?.file_path) return row.file_path;
    } catch (err) {
      process.stderr.write(
        `⚠ Index query failed for ${atomId} (${(err as Error).message}); falling back to file scan.\n`,
      );
    }
  }

  const files = listAtomFiles(memoryDir);
  for (const fp of files) {
    try {
      const atom = readAtom(fp);
      if (atom.frontmatter.id === atomId) return fp;
    } catch (err) {
      process.stderr.write(`⚠ Skipped unreadable atom file ${fp}: ${(err as Error).message}\n`);
    }
  }
  return null;
}
