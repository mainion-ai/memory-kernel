import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Portability guard (#341): the repo's shell scripts must run on the macOS
 * default `/bin/bash` 3.2, so they must not use bash-4-only builtins. The
 * existing script tests pass on a bash-4+ machine (and on Linux CI) regardless,
 * so this static check is what actually prevents a bash-4-ism from sneaking
 * back in and producing "command not found" false failures for Mac contributors.
 */
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');

// bash-4-only constructs, as whole-word / literal patterns. Comments are
// stripped before matching so a doc-comment mentioning the builtin is fine.
const BANNED: Array<{ re: RegExp; name: string }> = [
  { re: /\bmapfile\b/, name: 'mapfile (use: while IFS= read -r x; do arr+=("$x"); done < <(...))' },
  { re: /\breadarray\b/, name: 'readarray (same as mapfile — bash 4)' },
  { re: /\bdeclare\s+-A\b/, name: 'declare -A (associative arrays — bash 4)' },
  { re: /\blocal\s+-A\b/, name: 'local -A (associative arrays — bash 4)' },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^?[}]/, name: '${var^^} / ${var^} case conversion (bash 4)' },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*,,?[}]/, name: '${var,,} / ${var,} case conversion (bash 4)' },
];

function shellScripts(): string[] {
  if (!fs.existsSync(SCRIPTS_DIR)) return [];
  return fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh')).map((f) => path.join(SCRIPTS_DIR, f));
}

describe('shell scripts are bash-3.2 portable (#341)', () => {
  const scripts = shellScripts();

  it('there are shell scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  for (const file of scripts) {
    it(`${path.basename(file)} uses no bash-4-only builtins`, () => {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const offenders: string[] = [];
      lines.forEach((raw, i) => {
        if (/^\s*#/.test(raw)) return; // skip full-line comments
        for (const { re, name } of BANNED) {
          if (re.test(raw)) offenders.push(`  line ${i + 1}: ${name}\n    ${raw.trim()}`);
        }
      });
      expect(offenders, `${path.basename(file)} has bash-4-only constructs:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
