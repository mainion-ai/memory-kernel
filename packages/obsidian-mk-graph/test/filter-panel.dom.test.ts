// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createFilterPanel } from '../src/filter-panel.js';
import { defaultFilterState } from '../src/filter-state.js';

describe('createFilterPanel', () => {
  it('renders search + type / status / classification sections + orphans toggle', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    expect(root.querySelector('.mk-graph-filter-panel')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('.mk-graph-filter-search')).not.toBeNull();
    // 9 type checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-type-cb').length).toBe(9);
    // 8 status checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-status-cb').length).toBe(8);
    // 4 classification checkboxes
    expect(root.querySelectorAll('.mk-graph-filter-classification-cb').length).toBe(4);
    // orphans toggle
    expect(root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb')).not.toBeNull();
    p.destroy();
  });

  it('fires onChange when a type checkbox is toggled', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const factCb = root.querySelector<HTMLInputElement>('.mk-graph-filter-type-cb[data-value="fact"]')!;
    expect(factCb.checked).toBe(true);
    factCb.checked = false;
    factCb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.hiddenTypes.has('fact')).toBe(true);
    p.destroy();
  });

  it('fires onChange when the search input changes', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const search = root.querySelector<HTMLInputElement>('.mk-graph-filter-search')!;
    search.value = 'consensus';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].search).toBe('consensus');
    p.destroy();
  });

  it('fires onChange when orphans toggle is clicked', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange,
    });
    const cb = root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].orphansOnly).toBe(true);
    p.destroy();
  });

  it('renders tag chips from availableTags and toggles selection', () => {
    const root = document.createElement('div');
    const onChange = vi.fn();
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: ['fixture', 'belief', 'fact'],
      onChange,
    });
    const chips = root.querySelectorAll('.mk-graph-filter-tag-chip');
    expect(chips.length).toBe(3);
    const fixtureChip = root.querySelector<HTMLElement>('.mk-graph-filter-tag-chip[data-tag="fixture"]')!;
    fixtureChip.click();
    expect(onChange).toHaveBeenCalledOnce();
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.selectedTags.has('fixture')).toBe(true);
    p.destroy();
  });

  it('setAvailableTags re-renders chips when the loaded tag set changes', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: ['a', 'b'],
      onChange: () => {},
    });
    expect(root.querySelectorAll('.mk-graph-filter-tag-chip').length).toBe(2);
    p.setAvailableTags(['x', 'y', 'z']);
    expect(root.querySelectorAll('.mk-graph-filter-tag-chip').length).toBe(3);
    p.destroy();
  });

  it('setVisible toggles the panel display', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange: () => {},
    });
    const panel = root.querySelector<HTMLElement>('.mk-graph-filter-panel')!;
    expect(panel.classList.contains('is-hidden')).toBe(false);
    p.setVisible(false);
    expect(panel.classList.contains('is-hidden')).toBe(true);
    p.setVisible(true);
    expect(panel.classList.contains('is-hidden')).toBe(false);
    p.destroy();
  });

  it('destroy removes the panel from the parent', () => {
    const root = document.createElement('div');
    const p = createFilterPanel(root, {
      initialState: defaultFilterState(),
      availableTags: [],
      onChange: () => {},
    });
    expect(root.children.length).toBeGreaterThan(0);
    p.destroy();
    expect(root.children.length).toBe(0);
  });
});
