import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAtomFile } from '../src/atom-parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('fixture vault', () => {
  it('every fixture file parses cleanly', () => {
    const dir = path.join(here, 'fixtures', 'small-vault', 'ENTITIES');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const f of files) {
      const content = readFileSync(path.join(dir, f), 'utf-8');
      const atom = parseAtomFile(content, path.join(dir, f));
      expect(atom, `parsing ${f}`).not.toBeNull();
    }
  });
});
