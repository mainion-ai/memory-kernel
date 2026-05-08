import { describe, it, expect } from 'vitest';
import {
  defaultFilterState,
  matchesFilter,
  serializeFilterState,
  deserializeFilterState,
  type FilterState,
} from '../src/filter-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

const atom = (overrides: Partial<ParsedAtom> = {}): ParsedAtom => ({
  id: 'FACT-2026-04-01-X-aa00',
  type: 'fact',
  status: 'active',
  classification: 'TEAM',
  confidence: 1,
  createdAt: '2026-04-01T10:00:00Z',
  updatedAt: '2026-04-01T10:00:00Z',
  ttlDays: null,
  tags: [],
  relations: [],
  body: '',
  ...overrides,
});

const noReferences = (): boolean => false;
const allReferenced = (): boolean => true;

describe('defaultFilterState', () => {
  it('returns a state that matches every atom (no filters active)', () => {
    const s = defaultFilterState();
    expect(s.search).toBe('');
    expect(s.hiddenTypes.size).toBe(0);
    expect(s.hiddenStatuses.size).toBe(0);
    expect(s.hiddenClassifications.size).toBe(0);
    expect(s.selectedTags.size).toBe(0);
    expect(s.orphansOnly).toBe(false);
  });
});

describe('matchesFilter — type / status / classification', () => {
  it('returns true when no filters are active', () => {
    expect(matchesFilter(atom(), defaultFilterState(), noReferences)).toBe(true);
  });

  it('hides atoms whose type is in hiddenTypes', () => {
    const s = defaultFilterState();
    s.hiddenTypes.add('fact');
    expect(matchesFilter(atom({ type: 'fact' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'belief' }), s, noReferences)).toBe(true);
  });

  it('hides atoms whose status is in hiddenStatuses', () => {
    const s = defaultFilterState();
    s.hiddenStatuses.add('archived');
    expect(matchesFilter(atom({ status: 'archived' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ status: 'active' }), s, noReferences)).toBe(true);
  });

  it('hides atoms whose classification is in hiddenClassifications', () => {
    const s = defaultFilterState();
    s.hiddenClassifications.add('SECRET');
    expect(matchesFilter(atom({ classification: 'SECRET' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ classification: 'TEAM' }), s, noReferences)).toBe(true);
  });
});

describe('matchesFilter — selectedTags', () => {
  it('empty selectedTags = no tag filter (all atoms pass)', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ tags: ['foo'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: [] }), s, noReferences)).toBe(true);
  });

  it('non-empty selectedTags = atom must have at least one matching tag', () => {
    const s = defaultFilterState();
    s.selectedTags.add('decision-2026');
    expect(matchesFilter(atom({ tags: ['decision-2026'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['other', 'decision-2026'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['unrelated'] }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ tags: [] }), s, noReferences)).toBe(false);
  });
});

describe('matchesFilter — search', () => {
  it('empty search = no search filter', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ id: 'X', body: 'Y' }), s, noReferences)).toBe(true);
  });

  it('search matches atom id (case-insensitive substring)', () => {
    const s = defaultFilterState();
    s.search = 'fix04';
    expect(matchesFilter(atom({ id: 'PREF-2026-04-05-FIX04-aa04' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ id: 'OTHER-aa00' }), s, noReferences)).toBe(false);
  });

  it('search matches atom body', () => {
    const s = defaultFilterState();
    s.search = 'consensus';
    expect(matchesFilter(atom({ body: 'We reached consensus on...' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ body: 'unrelated body' }), s, noReferences)).toBe(false);
  });

  it('search matches atom tags', () => {
    const s = defaultFilterState();
    s.search = 'fixture';
    expect(matchesFilter(atom({ tags: ['fixture', 'belief'] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ tags: ['decision'] }), s, noReferences)).toBe(false);
  });
});

describe('matchesFilter — orphansOnly', () => {
  it('off: all atoms pass regardless of relations', () => {
    const s = defaultFilterState();
    expect(matchesFilter(atom({ relations: [] }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ relations: [{ target: 'X', type: 'related' }] }), s, allReferenced)).toBe(true);
  });

  it('on: hides atoms with outbound relations', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    const withRel = atom({ relations: [{ target: 'X', type: 'related' }] });
    expect(matchesFilter(withRel, s, noReferences)).toBe(false);
  });

  it('on: hides atoms that are referenced inbound', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    const referenced = atom({ id: 'TARGET' });
    expect(matchesFilter(referenced, s, allReferenced)).toBe(false);
    expect(matchesFilter(referenced, s, noReferences)).toBe(true);
  });

  it('on: shows atoms with no outbound and no inbound', () => {
    const s = defaultFilterState();
    s.orphansOnly = true;
    expect(matchesFilter(atom({ relations: [] }), s, noReferences)).toBe(true);
  });
});

describe('matchesFilter — combinations', () => {
  it('AND-combines all dimensions; first failing dimension shortcircuits', () => {
    const s = defaultFilterState();
    s.search = 'foo';
    s.hiddenTypes.add('belief');
    s.hiddenStatuses.add('archived');
    expect(matchesFilter(atom({ type: 'fact', status: 'active', body: 'foo bar' }), s, noReferences)).toBe(true);
    expect(matchesFilter(atom({ type: 'belief', body: 'foo bar' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'fact', status: 'archived', body: 'foo bar' }), s, noReferences)).toBe(false);
    expect(matchesFilter(atom({ type: 'fact', body: 'no match' }), s, noReferences)).toBe(false);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips through JSON', () => {
    const s: FilterState = defaultFilterState();
    s.search = 'foo';
    s.hiddenTypes.add('belief').add('fact');
    s.hiddenStatuses.add('archived');
    s.hiddenClassifications.add('SECRET');
    s.selectedTags.add('a').add('b');
    s.orphansOnly = true;
    const blob = serializeFilterState(s);
    const json = JSON.parse(JSON.stringify(blob));
    const back = deserializeFilterState(json);
    expect(back.search).toBe('foo');
    expect([...back.hiddenTypes].sort()).toEqual(['belief', 'fact']);
    expect([...back.hiddenStatuses]).toEqual(['archived']);
    expect([...back.hiddenClassifications]).toEqual(['SECRET']);
    expect([...back.selectedTags].sort()).toEqual(['a', 'b']);
    expect(back.orphansOnly).toBe(true);
  });

  it('deserializes a missing or partial blob to default state', () => {
    expect(deserializeFilterState(undefined)).toEqual(defaultFilterState());
    expect(deserializeFilterState(null)).toEqual(defaultFilterState());
    expect(deserializeFilterState({})).toEqual(defaultFilterState());
    const partial = deserializeFilterState({ search: 'x' });
    expect(partial.search).toBe('x');
    expect(partial.hiddenTypes.size).toBe(0);
  });
});
