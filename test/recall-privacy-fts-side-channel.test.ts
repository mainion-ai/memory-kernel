/**
 * Privacy filter sibling for the FTS recall path (#135).
 *
 * PR-6 (#134) closed the SECRET/PERSONAL leak in `getAllEmbeddings` so the
 * semantic / KNN graph-boost layer no longer scores SECRET vectors. The
 * lexical (FTS) layer had the analogous gap: `searchFts`,
 * `getTermDocumentFrequencies`, and `getAtomsMatchingTerm` returned SECRET
 * hits, which then shifted BM25 normalization, IDF damping, and coverage
 * boosts for visible TEAM atoms — a low-bandwidth side channel.
 *
 * This test pins the post-fix behaviour: those three helpers all apply the
 * same classification predicate that `queryIndex` and `getAllEmbeddings`
 * apply (NULL or NOT IN ('SECRET','PERSONAL')).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initMemoryDir } from '../src/store.js';
import { createAtom } from '../src/retain.js';
import { reindex, searchFts, getTermDocumentFrequencies, getAtomsMatchingTerm, closeAllIndexes } from '../src/index-db.js';

const AGENT = 'test-agent';
const SESSION = 'test-session';
const KEYWORD = 'zephyrquark';

let memoryDir: string;

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-fts-priv-'));
  initMemoryDir(memoryDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: AGENT,
  session_id: SESSION,
});

describe('FTS privacy filter (#135) — SECRET / PERSONAL exclusion', () => {
  it('searchFts excludes SECRET atoms from the result set', () => {
    const visible = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'visible-team',
      body: `Visible team atom mentioning ${KEYWORD} once.`,
      classification: 'TEAM',
    });
    const secret = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'hidden-secret',
      body: `Secret atom mentioning ${KEYWORD} in confidential context.`,
      classification: 'SECRET',
    });
    reindex(memoryDir);

    const hits = searchFts(memoryDir, KEYWORD, 50);
    expect(hits).not.toBeNull();
    const ids = hits!.map((h) => h.atom_id);
    expect(ids).toContain(visible.frontmatter.id);
    expect(ids).not.toContain(secret.frontmatter.id);
  });

  it('searchFts excludes PERSONAL atoms from the result set', () => {
    const visible = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'team-visible',
      body: `Visible team atom mentioning ${KEYWORD}.`,
      classification: 'TEAM',
    });
    const personal = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'personal-private',
      body: `Personal atom mentioning ${KEYWORD} privately.`,
      classification: 'PERSONAL',
    });
    reindex(memoryDir);

    const hits = searchFts(memoryDir, KEYWORD, 50);
    expect(hits).not.toBeNull();
    const ids = hits!.map((h) => h.atom_id);
    expect(ids).toContain(visible.frontmatter.id);
    expect(ids).not.toContain(personal.frontmatter.id);
  });

  it('getTermDocumentFrequencies counts only visible (non-SECRET/PERSONAL) docs', () => {
    createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'team-1',
      body: `Team atom referencing ${KEYWORD}.`,
      classification: 'TEAM',
    });
    createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'secret-1',
      body: `Secret atom referencing ${KEYWORD}.`,
      classification: 'SECRET',
    });
    createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'personal-1',
      body: `Personal atom referencing ${KEYWORD}.`,
      classification: 'PERSONAL',
    });
    reindex(memoryDir);

    const dfMap = getTermDocumentFrequencies(memoryDir, [KEYWORD]);
    expect(dfMap).not.toBeNull();
    // Three atoms in storage, but only the TEAM atom should contribute to DF.
    // Pre-fix: dfMap.get(KEYWORD) === 3. Post-fix: === 1.
    expect(dfMap!.get(KEYWORD)).toBe(1);
  });

  it('getAtomsMatchingTerm does not include SECRET / PERSONAL atom IDs', () => {
    const team = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'team-match',
      body: `Public mention of ${KEYWORD}.`,
      classification: 'TEAM',
    });
    const secret = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'secret-match',
      body: `Secret mention of ${KEYWORD}.`,
      classification: 'SECRET',
    });
    const personal = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'personal-match',
      body: `Personal mention of ${KEYWORD}.`,
      classification: 'PERSONAL',
    });
    reindex(memoryDir);

    const matching = getAtomsMatchingTerm(memoryDir, KEYWORD);
    expect(matching.has(team.frontmatter.id)).toBe(true);
    expect(matching.has(secret.frontmatter.id)).toBe(false);
    expect(matching.has(personal.frontmatter.id)).toBe(false);
  });

  it('preserves NULL-classification atoms (regression guard for pre-classification rows)', () => {
    // createAtom always emits classification (defaults to TEAM). Pre-classification
    // atoms imported from legacy stores have no classification frontmatter at all
    // and must remain visible — the SQL predicate is `classification IS NULL OR
    // classification NOT IN ('SECRET','PERSONAL')`.
    //
    // Create a normal atom, then strip the `classification:` line from its file
    // on disk and reindex. The shape now matches a legacy pre-classification atom.
    const atom = createAtom({
      ...base(memoryDir),
      type: 'fact',
      slug: 'legacy-null',
      body: `Legacy pre-classification atom referencing ${KEYWORD}.`,
      classification: 'TEAM',
    });
    const filePath = atom.filePath!;
    const original = fs.readFileSync(filePath, 'utf-8');
    const stripped = original.replace(/^classification:.*\n/m, '');
    fs.writeFileSync(filePath, stripped);
    reindex(memoryDir);

    const hits = searchFts(memoryDir, KEYWORD, 50);
    expect(hits).not.toBeNull();
    const ids = hits!.map((h) => h.atom_id);
    expect(ids).toContain(atom.frontmatter.id);
  });

});
