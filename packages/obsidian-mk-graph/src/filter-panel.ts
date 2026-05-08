import { ATOM_TYPE_ORDER, ATOM_STATUS_ORDER, ATOM_CLASSIFICATION_ORDER } from './atom-types.js';
import type { FilterState } from './filter-state.js';

export interface FilterPanelOptions {
  initialState: FilterState;
  availableTags: string[];
  onChange: (state: FilterState) => void;
}

export interface FilterPanelHandle {
  setState(state: FilterState): void;
  setAvailableTags(tags: string[]): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * Mount the filter panel into `parent`. Returns a handle for the view
 * to drive panel state from outside (e.g. when filter state is mutated
 * by a different code path, or when the available tags change after a
 * vault reload).
 *
 * Layout produced:
 *   <div class="mk-graph-filter-panel">
 *     <div class="mk-graph-filter-header">Filters</div>
 *     <input class="mk-graph-filter-search" type="search" placeholder="Search atoms…" />
 *     <section> Types        — 9 checkboxes
 *     <section> Status       — 8 checkboxes
 *     <section> Classification — 4 checkboxes
 *     <section> Tags         — chips (selectable)
 *     <section> Other        — orphans toggle
 *
 * The panel is a pure DOM component — it owns its own state copy
 * internally, fires `onChange(state)` after every interaction, and
 * accepts external state updates via `setState()`. The view reconciles
 * its single source of truth with this internal copy through the
 * onChange callback.
 */
export function createFilterPanel(parent: HTMLElement, opts: FilterPanelOptions): FilterPanelHandle {
  const doc = parent.ownerDocument;

  // Internal state: cloned from initialState so external mutations don't leak.
  let state: FilterState = cloneState(opts.initialState);
  let tags: string[] = [...opts.availableTags];

  const root = doc.createElement('div');
  root.classList.add('mk-graph-filter-panel');

  // Header
  const header = doc.createElement('div');
  header.classList.add('mk-graph-filter-header');
  header.textContent = 'Filters';
  root.appendChild(header);

  // Search
  const search = doc.createElement('input');
  search.type = 'search';
  search.classList.add('mk-graph-filter-search');
  search.placeholder = 'Search atoms…';
  search.value = state.search;
  search.addEventListener('input', () => {
    state = { ...state, search: search.value };
    opts.onChange(state);
  });
  root.appendChild(search);

  // Type checkboxes
  const typeSection = makeSection(doc, 'Types');
  for (const t of ATOM_TYPE_ORDER) {
    typeSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-type-cb',
      value: t,
      label: t,
      checked: !state.hiddenTypes.has(t),
      onChange: (checked) => {
        const next = new Set(state.hiddenTypes);
        if (checked) next.delete(t); else next.add(t);
        state = { ...state, hiddenTypes: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(typeSection.root);

  // Status checkboxes
  const statusSection = makeSection(doc, 'Status');
  for (const s of ATOM_STATUS_ORDER) {
    statusSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-status-cb',
      value: s,
      label: s,
      checked: !state.hiddenStatuses.has(s),
      onChange: (checked) => {
        const next = new Set(state.hiddenStatuses);
        if (checked) next.delete(s); else next.add(s);
        state = { ...state, hiddenStatuses: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(statusSection.root);

  // Classification checkboxes
  const classificationSection = makeSection(doc, 'Classification');
  for (const c of ATOM_CLASSIFICATION_ORDER) {
    classificationSection.body.appendChild(makeCheckbox(doc, {
      cls: 'mk-graph-filter-classification-cb',
      value: c,
      label: c,
      checked: !state.hiddenClassifications.has(c),
      onChange: (checked) => {
        const next = new Set(state.hiddenClassifications);
        if (checked) next.delete(c); else next.add(c);
        state = { ...state, hiddenClassifications: next };
        opts.onChange(state);
      },
    }));
  }
  root.appendChild(classificationSection.root);

  // Tags
  const tagsSection = makeSection(doc, 'Tags');
  const tagsBody = tagsSection.body;
  function renderTagChips(): void {
    tagsBody.replaceChildren();
    if (tags.length === 0) {
      const empty = doc.createElement('div');
      empty.classList.add('mk-graph-filter-tags-empty');
      empty.textContent = '(no tags)';
      tagsBody.appendChild(empty);
      return;
    }
    for (const t of tags) {
      const chip = doc.createElement('span');
      chip.classList.add('mk-graph-filter-tag-chip');
      chip.dataset.tag = t;
      chip.textContent = t;
      if (state.selectedTags.has(t)) chip.classList.add('is-active');
      chip.addEventListener('click', () => {
        const next = new Set(state.selectedTags);
        if (next.has(t)) next.delete(t); else next.add(t);
        state = { ...state, selectedTags: next };
        chip.classList.toggle('is-active', next.has(t));
        opts.onChange(state);
      });
      tagsBody.appendChild(chip);
    }
  }
  renderTagChips();
  root.appendChild(tagsSection.root);

  // Orphans toggle
  const otherSection = makeSection(doc, 'Other');
  otherSection.body.appendChild(makeCheckbox(doc, {
    cls: 'mk-graph-filter-orphans-cb',
    value: 'orphans',
    label: 'Orphans only',
    checked: state.orphansOnly,
    onChange: (checked) => {
      state = { ...state, orphansOnly: checked };
      opts.onChange(state);
    },
  }));
  root.appendChild(otherSection.root);

  parent.appendChild(root);

  function setState(newState: FilterState): void {
    state = cloneState(newState);
    search.value = state.search;
    syncCheckboxes(root, '.mk-graph-filter-type-cb', (cb) => !state.hiddenTypes.has(cb.dataset.value ?? ''));
    syncCheckboxes(root, '.mk-graph-filter-status-cb', (cb) => !state.hiddenStatuses.has(cb.dataset.value ?? ''));
    syncCheckboxes(root, '.mk-graph-filter-classification-cb', (cb) => !state.hiddenClassifications.has(cb.dataset.value ?? ''));
    const orphansCb = root.querySelector<HTMLInputElement>('.mk-graph-filter-orphans-cb');
    if (orphansCb) orphansCb.checked = state.orphansOnly;
    renderTagChips();
  }

  function setAvailableTags(newTags: string[]): void {
    tags = [...newTags];
    renderTagChips();
  }

  function setVisible(visible: boolean): void {
    root.classList.toggle('is-hidden', !visible);
  }

  function destroy(): void {
    if (root.parentNode === parent) parent.removeChild(root);
  }

  return { setState, setAvailableTags, setVisible, destroy };
}

// --- private helpers ---

function cloneState(s: FilterState): FilterState {
  return {
    search: s.search,
    hiddenTypes: new Set(s.hiddenTypes),
    hiddenStatuses: new Set(s.hiddenStatuses),
    hiddenClassifications: new Set(s.hiddenClassifications),
    selectedTags: new Set(s.selectedTags),
    orphansOnly: s.orphansOnly,
  };
}

function makeSection(doc: Document, title: string): { root: HTMLElement; body: HTMLElement } {
  const root = doc.createElement('section');
  root.classList.add('mk-graph-filter-section');
  const heading = doc.createElement('div');
  heading.classList.add('mk-graph-filter-section-heading');
  heading.textContent = title;
  root.appendChild(heading);
  const body = doc.createElement('div');
  body.classList.add('mk-graph-filter-section-body');
  root.appendChild(body);
  return { root, body };
}

interface CheckboxOpts {
  cls: string;
  value: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function makeCheckbox(doc: Document, opts: CheckboxOpts): HTMLLabelElement {
  const label = doc.createElement('label');
  label.classList.add('mk-graph-filter-cb-label');
  const cb = doc.createElement('input');
  cb.type = 'checkbox';
  cb.classList.add(opts.cls);
  cb.dataset.value = opts.value;
  cb.checked = opts.checked;
  cb.addEventListener('change', () => opts.onChange(cb.checked));
  label.appendChild(cb);
  const text = doc.createElement('span');
  text.classList.add('mk-graph-filter-cb-text');
  text.textContent = opts.label;
  label.appendChild(text);
  return label;
}

function syncCheckboxes(root: HTMLElement, selector: string, isChecked: (cb: HTMLInputElement) => boolean): void {
  for (const cb of root.querySelectorAll<HTMLInputElement>(selector)) {
    cb.checked = isChecked(cb);
  }
}
