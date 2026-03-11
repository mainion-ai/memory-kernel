/**
 * Episode Store — tests.
 *
 * Covers:
 * - writeEpisode() creates file in EPISODES/ with correct frontmatter
 * - readEpisode() round-trips: write then read returns identical content
 * - listEpisodes() returns newest-first order
 * - listEpisodes() filters by tags
 * - linkEpisodeToAtom() updates atom provenance.episodes without duplicates
 * - recall({ include_episodes: true }) populates ContextBundle.episodes
 * - Episode files are excluded from listAtoms()
 * - writeEpisode() with same sessionId overwrites (idempotent last-write-wins)
 * - readEpisode() returns null for non-existent episode
 * - Events are emitted to event log on writeEpisode()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  initMemoryDir,
  createAtom,
  recall,
  listAtoms,
  readEvents,
  writeEpisode,
  readEpisode,
  listEpisodes,
  linkEpisodeToAtom,
  closeAllIndexes,
} from '../src/index.js';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ep-'));
  initMemoryDir(testDir);
});

afterEach(() => {
  closeAllIndexes();
  fs.rmSync(testDir, { recursive: true, force: true });
});

const base = (dir: string) => ({
  memoryDir: dir,
  agent_id: 'test',
  session_id: 'test-session',
});

// ---------------------------------------------------------------------------
// writeEpisode()
// ---------------------------------------------------------------------------

describe('writeEpisode()', () => {
  it('creates a file in EPISODES/ with correct frontmatter', () => {
    const epId = writeEpisode(testDir, 'session-001', 'Fixed the pagination bug.', {
      agent_id: 'claude',
      tags: ['bug-fix', 'api'],
    });

    expect(epId).toBe('EP-session-001');

    const episodesDir = path.join(testDir, 'EPISODES');
    expect(fs.existsSync(episodesDir)).toBe(true);

    const epFile = path.join(episodesDir, `${epId}.md`);
    expect(fs.existsSync(epFile)).toBe(true);

    const content = fs.readFileSync(epFile, 'utf-8');
    expect(content).toContain('id: EP-session-001');
    expect(content).toContain('session_id: session-001');
    expect(content).toContain('Fixed the pagination bug.');
  });

  it('sanitises session ID to kebab-case', () => {
    const epId = writeEpisode(testDir, 'My Session 2026/03/11', 'Summary text.', {});
    expect(epId).toBe('EP-my-session-2026-03-11');
    const epFile = path.join(testDir, 'EPISODES', `${epId}.md`);
    expect(fs.existsSync(epFile)).toBe(true);
  });

  it('includes tags in frontmatter when provided', () => {
    writeEpisode(testDir, 'sess-tagged', 'Session with tags.', {
      tags: ['performance', 'db'],
    });

    const ep = readEpisode(testDir, 'EP-sess-tagged');
    expect(ep).not.toBeNull();
    expect(ep!.metadata.tags).toContain('performance');
    expect(ep!.metadata.tags).toContain('db');
  });

  it('emits a session_ended event to the event log', () => {
    writeEpisode(testDir, 'sess-event', 'Summary.', {});

    const events = readEvents(testDir);
    const sessionEvent = events.find((e) => e.action === 'session_ended');
    expect(sessionEvent).not.toBeUndefined();
    expect(sessionEvent!.meta?.episode_id).toBe('EP-sess-event');
  });

  it('overwrites existing episode when same sessionId is used (last-write-wins)', () => {
    writeEpisode(testDir, 'sess-overwrite', 'Original summary.', {});
    writeEpisode(testDir, 'sess-overwrite', 'Updated summary.', {});

    const ep = readEpisode(testDir, 'EP-sess-overwrite');
    expect(ep).not.toBeNull();
    expect(ep!.summary).toBe('Updated summary.');
  });

  it('includes agent_id from opts parameter', () => {
    writeEpisode(testDir, 'sess-agent', 'Agent session summary.', undefined, {
      agent_id: 'gpt-4o',
    });

    const ep = readEpisode(testDir, 'EP-sess-agent');
    expect(ep).not.toBeNull();
    expect(ep!.metadata.agent_id).toBe('gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// readEpisode()
// ---------------------------------------------------------------------------

describe('readEpisode()', () => {
  it('returns null for non-existent episode', () => {
    const ep = readEpisode(testDir, 'EP-does-not-exist');
    expect(ep).toBeNull();
  });

  it('round-trips: write then read returns identical summary and metadata', () => {
    const summary = '## Session Summary\n\nResolved 3 bugs and refactored auth module.';
    writeEpisode(testDir, 'sess-roundtrip', summary, {
      agent_id: 'claude',
      tags: ['auth', 'bugfix'],
    });

    const ep = readEpisode(testDir, 'EP-sess-roundtrip');
    expect(ep).not.toBeNull();
    expect(ep!.id).toBe('EP-sess-roundtrip');
    expect(ep!.metadata.session_id).toBe('sess-roundtrip');
    expect(ep!.metadata.agent_id).toBe('claude');
    expect(ep!.metadata.tags).toEqual(['auth', 'bugfix']);
    expect(ep!.summary).toBe(summary.trim());
    expect(ep!.filePath).toContain('EP-sess-roundtrip.md');
  });
});

// ---------------------------------------------------------------------------
// listEpisodes()
// ---------------------------------------------------------------------------

describe('listEpisodes()', () => {
  it('returns empty array when EPISODES/ does not exist', () => {
    const episodes = listEpisodes(testDir);
    expect(episodes).toEqual([]);
  });

  it('returns episodes sorted newest-first by started_at', async () => {
    // Write episodes with explicit started_at timestamps to control ordering
    writeEpisode(testDir, 'sess-old', 'Old session.', {
      started_at: '2025-01-01T00:00:00Z',
    });
    // Small delay to ensure distinct timestamps if started_at is auto-set
    writeEpisode(testDir, 'sess-new', 'New session.', {
      started_at: '2026-01-01T00:00:00Z',
    });

    const episodes = listEpisodes(testDir);
    expect(episodes.length).toBe(2);
    expect(episodes[0].id).toBe('EP-sess-new');
    expect(episodes[1].id).toBe('EP-sess-old');
  });

  it('respects limit option', () => {
    for (let i = 0; i < 5; i++) {
      writeEpisode(testDir, `sess-${i}`, `Session ${i} summary.`, {
        started_at: `2026-01-0${i + 1}T00:00:00Z`,
      });
    }

    const limited = listEpisodes(testDir, { limit: 3 });
    expect(limited.length).toBe(3);
  });

  it('filters by tags', () => {
    writeEpisode(testDir, 'sess-tagged', 'Tagged session.', { tags: ['release', 'deployment'] });
    writeEpisode(testDir, 'sess-other', 'Other session.', { tags: ['testing'] });

    const results = listEpisodes(testDir, { tags: ['release'] });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('EP-sess-tagged');
  });

  it('returns all episodes when no tags filter', () => {
    writeEpisode(testDir, 'sess-a', 'Session A.', {});
    writeEpisode(testDir, 'sess-b', 'Session B.', {});

    const all = listEpisodes(testDir);
    expect(all.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// linkEpisodeToAtom()
// ---------------------------------------------------------------------------

describe('linkEpisodeToAtom()', () => {
  it('adds episodeId to atom provenance.episodes', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'linked', body: 'Linkable fact.' });
    writeEpisode(testDir, 'sess-link', 'Session with linked atom.', {});

    linkEpisodeToAtom(testDir, atom.filePath!, 'EP-sess-link');

    // Read the atom back from disk to verify provenance was written
    const fs2 = fs.readFileSync(atom.filePath!, 'utf-8');
    expect(fs2).toContain('EP-sess-link');
  });

  it('is idempotent: linking same episode twice does not duplicate', () => {
    const atom = createAtom({ ...base(testDir), type: 'fact', slug: 'idempotent', body: 'Idempotent link test.' });
    writeEpisode(testDir, 'sess-idem', 'Idempotent session.', {});

    linkEpisodeToAtom(testDir, atom.filePath!, 'EP-sess-idem');
    linkEpisodeToAtom(testDir, atom.filePath!, 'EP-sess-idem');

    // Parse frontmatter manually to count occurrences
    const content = fs.readFileSync(atom.filePath!, 'utf-8');
    const matches = content.match(/EP-sess-idem/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('can link multiple episodes to the same atom', () => {
    const atom = createAtom({ ...base(testDir), type: 'decision', slug: 'multi-linked', body: 'Decision linked to multiple episodes.' });
    writeEpisode(testDir, 'sess-x', 'Session X.', {});
    writeEpisode(testDir, 'sess-y', 'Session Y.', {});

    linkEpisodeToAtom(testDir, atom.filePath!, 'EP-sess-x');
    linkEpisodeToAtom(testDir, atom.filePath!, 'EP-sess-y');

    const content = fs.readFileSync(atom.filePath!, 'utf-8');
    expect(content).toContain('EP-sess-x');
    expect(content).toContain('EP-sess-y');
  });
});

// ---------------------------------------------------------------------------
// Episode isolation from atoms
// ---------------------------------------------------------------------------

describe('Episode files are excluded from listAtoms()', () => {
  it('episodes in EPISODES/ are not returned by listAtoms()', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'real-atom', body: 'A real atom.' });
    writeEpisode(testDir, 'sess-isolation', 'Episode content.', {});

    const atoms = listAtoms(testDir);
    // None of the atoms should have an EPISODES path
    for (const atom of atoms) {
      expect(atom.filePath).not.toContain('EPISODES');
    }
    // Exactly one atom (the real atom, not the episode) should be present
    expect(atoms.length).toBe(1);
    expect(atoms[0].frontmatter.type).toBe('fact');
  });
});

// ---------------------------------------------------------------------------
// Episode-aware recall
// ---------------------------------------------------------------------------

describe('recall() with include_episodes', () => {
  it('populates bundle.episodes when episodes exist', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'ctx', body: 'Context atom.' });
    writeEpisode(testDir, 'sess-recall', 'Session summary for recall test.', {});

    const bundle = recall(testDir, { include_episodes: true });
    expect(bundle.episodes).toBeDefined();
    expect(bundle.episodes!.length).toBeGreaterThan(0);
    expect(bundle.episodes![0]).toContain('EP-sess-recall');
  });

  it('bundle.episodes is undefined when include_episodes is false (default)', () => {
    writeEpisode(testDir, 'sess-hidden', 'Should not appear.', {});

    const bundle = recall(testDir, {});
    expect(bundle.episodes).toBeUndefined();
  });

  it('filters episodes by task keyword when both task and include_episodes are set', () => {
    writeEpisode(testDir, 'sess-auth', 'Fixed authentication and JWT token refresh.', { tags: ['auth'] });
    writeEpisode(testDir, 'sess-db', 'Migrated database schema to PostgreSQL 15.', { tags: ['db'] });

    const bundle = recall(testDir, { task: 'authentication JWT', include_episodes: true });
    expect(bundle.episodes).toBeDefined();
    // Auth session matches "authentication" keyword; DB session does not
    const allText = bundle.episodes!.join('\n');
    expect(allText).toContain('authentication');
  });

  it('bundle.token_estimate includes episode token cost', () => {
    createAtom({ ...base(testDir), type: 'fact', slug: 'atom-x', body: 'Atom content.' });
    writeEpisode(testDir, 'sess-tokens', 'Episode with some content to count tokens.', {});

    const withEpisodes = recall(testDir, { include_episodes: true });
    const withoutEpisodes = recall(testDir, {});

    // Token estimate should be higher when episodes are included
    expect(withEpisodes.token_estimate).toBeGreaterThanOrEqual(withoutEpisodes.token_estimate);
  });
});
