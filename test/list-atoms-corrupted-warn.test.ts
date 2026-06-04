/**
 * Issue #100 — listAtoms must warn on corrupted atom files instead of
 * silently dropping them. The existing encryption-key-missing warning
 * (added in v0.9.0) is extended to cover all parse failures so an operator
 * can discover the loss without grepping the filesystem.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initMemoryDir,
  createAtom,
  listAtoms,
  closeAllIndexes,
} from '../src/index.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
let testDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-listatoms-warn-'));
  initMemoryDir(testDir);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

/** Helper: gather all stderr writes captured by the spy as an array of strings. */
function stderrLines(): string[] {
  return stderrSpy.mock.calls.map((call) => String(call[0]));
}

describe('listAtoms — warn on corrupted atom files (#100)', () => {
  it('malformed YAML: atom skipped and stderr warning includes relative path + error class name', () => {
    // Write a deliberately malformed .md file directly to ENTITIES/.
    // The frontmatter delimiters are valid but the YAML body is not parseable.
    const filePath = path.join(testDir, 'ENTITIES', 'CORRUPT-001.md');
    fs.writeFileSync(filePath, '---\nthis is: : not yaml\n---\nbody\n');

    const atoms = listAtoms(testDir);

    // Atom must NOT appear in the listing.
    expect(atoms.find((a) => a.frontmatter.id === 'CORRUPT-001')).toBeUndefined();

    // Exactly one stderr line should be emitted.
    const lines = stderrLines();
    const warnings = lines.filter((l) => l.toLowerCase().includes('warning'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    // The warning must include the filename (relative or absolute) and an error class name.
    const warningText = warnings.join('');
    expect(warningText).toContain('CORRUPT-001.md');
    // The thrown error from gray-matter/js-yaml is an Error subclass; the warning
    // must include the constructor name (e.g. "Error", "YAMLException").
    expect(warningText).toMatch(/Error|Exception/);
  });

  it('one valid + one corrupt: returns the valid atom and emits exactly one warning', () => {
    // Create one well-formed atom via the public API
    const good = createAtom({
      memoryDir: testDir,
      agent_id: AGENT,
      session_id: SESSION,
      type: 'fact',
      slug: 'valid-atom',
      body: 'This atom parses fine.',
    });

    // Drop a malformed sibling into the same dir
    const corruptPath = path.join(testDir, 'ENTITIES', 'CORRUPT-002.md');
    fs.writeFileSync(corruptPath, '---\nbroken: : :\n---\nnope\n');

    // Reset spy so we only count warnings emitted by the listAtoms call we measure.
    stderrSpy.mockClear();

    const atoms = listAtoms(testDir);

    // Only the valid atom is returned.
    expect(atoms).toHaveLength(1);
    expect(atoms[0].frontmatter.id).toBe(good.frontmatter.id);

    // Exactly one warning line was emitted (one per corrupted file, not duplicated).
    const warnings = stderrLines().filter((l) => l.toLowerCase().includes('warning'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CORRUPT-002.md');
  });

  it('encryption-error branch preserved: existing key-missing warning still fires for encrypted atoms', () => {
    // Create a SECRET atom WITH a key set.
    const TEST_KEY = 'deadbeef'.repeat(8); // 64-char hex
    process.env.MEMORY_ENCRYPTION_KEY = TEST_KEY;
    try {
      createAtom({
        memoryDir: testDir,
        agent_id: AGENT,
        session_id: SESSION,
        type: 'fact',
        slug: 'secret-needs-key',
        body: 'Encrypted body.',
        classification: 'SECRET',
      });
    } finally {
      delete process.env.MEMORY_ENCRYPTION_KEY;
    }

    // Clear stderr captures from the createAtom path (events log writes etc.
    // do not write to stderr today, but be defensive).
    stderrSpy.mockClear();

    // Now call listAtoms with NO key set.
    const atoms = listAtoms(testDir);

    // The SECRET atom is skipped.
    expect(atoms).toHaveLength(0);

    // The existing encryption-specific warning still fires — verify the
    // user-actionable "MEMORY_ENCRYPTION_KEY" hint is present so we don't
    // accidentally regress that branch by routing it through the generic path.
    const warnings = stderrLines().filter((l) => l.toLowerCase().includes('warning'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.join('')).toContain('MEMORY_ENCRYPTION_KEY');
  });

  it('YAML schema violation (missing required `id`): warning fires with error class name', () => {
    // Valid YAML, but missing the required `id` field. parseAtom throws a plain
    // Error from format.ts:99 — the generic branch must catch it and warn.
    const filePath = path.join(testDir, 'ENTITIES', 'SCHEMA-VIOLATION.md');
    fs.writeFileSync(
      filePath,
      '---\ntype: fact\nstatus: draft\n---\nBody without an id field.\n',
    );

    const atoms = listAtoms(testDir);

    // Atom without an id cannot be loaded.
    expect(atoms.find((a) => a.frontmatter.id === undefined)).toBeUndefined();
    expect(atoms.find((a) => /SCHEMA-VIOLATION/i.test(a.frontmatter.id ?? ''))).toBeUndefined();

    const warnings = stderrLines().filter((l) => l.toLowerCase().includes('warning'));
    expect(warnings.length).toBeGreaterThanOrEqual(1);

    const warningText = warnings.join('');
    expect(warningText).toContain('SCHEMA-VIOLATION.md');
    // The thrown error is a plain Error from format.ts — class name must appear.
    expect(warningText).toContain('Error');
    // And the underlying message about the missing id field should be surfaced
    // so the operator can fix the file without re-running with extra logging.
    expect(warningText.toLowerCase()).toContain('id');
  });
});
