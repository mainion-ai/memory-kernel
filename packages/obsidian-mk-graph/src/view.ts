import { ItemView, Notice, WorkspaceLeaf, normalizePath, type App } from 'obsidian';
import path from 'node:path';
import { GraphState } from './graph-state.js';
import {
  readVault,
  watchVault,
  resolveMemoryDir,
  readEvents,
  watchEvents,
  type Watcher,
} from './data-loader.js';
import { createRenderer, type RendererHandle } from './renderer.js';
import type { MkGraphSettings } from './settings.js';
import type { ParsedAtom } from './atom-parser.js';
import { ReplayController } from './replay-controller.js';
import { createScrubber, type ScrubberHandle, type ReplayMode } from './scrubber.js';
import { computeHistogram } from './density-histogram.js';
import type { EventsWatcher } from './events-loader.js';
import type { PluginEvent } from './event-parser.js';
import { createFilterPanel, type FilterPanelHandle } from './filter-panel.js';
import {
  defaultFilterState,
  matchesFilter,
  serializeFilterState,
  deserializeFilterState,
  type FilterState,
} from './filter-state.js';

export const MK_GRAPH_VIEW_TYPE = 'mk-graph-view';

export interface ViewHost {
  app: App;
  settings: MkGraphSettings;
  saveSettings(): Promise<void>;
}

export class MkGraphView extends ItemView {
  private state: GraphState = new GraphState();
  private renderer: RendererHandle | null = null;
  private watcher: Watcher | null = null;
  private eventsWatcher: EventsWatcher | null = null;
  private scrubber: ScrubberHandle | null = null;
  private controller: ReplayController | null = null;
  private events: PluginEvent[] = [];
  private filterPanel: FilterPanelHandle | null = null;
  private filterState: FilterState = defaultFilterState();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ViewHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return MK_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Memory Kernel Graph';
  }

  getIcon(): string {
    return 'git-branch';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.classList.add('mk-graph-view-container');

    this.filterState = deserializeFilterState(this.host.settings.filters);

    this.controller = new ReplayController({
      onState: (s) => {
        const referenced = this.computeReferencedSet(s.atoms);
        const filtered = s.atoms.filter((a) => matchesFilter(a, this.filterState, (id) => referenced.has(id)));
        this.state.replace(filtered);
        this.renderer?.setDiff(s.diff);
        if (this.scrubber && s.asOf) this.scrubber.setPlayhead(s.asOf);
        // Refresh tag chips after a load — the available tag set might
        // have changed.
        this.filterPanel?.setAvailableTags(this.collectTags(s.atoms));
      },
    });

    const initialMode: ReplayMode = this.host.settings.liveModeOnStartup ? 'live' : 'scrubbed';
    this.controller.setMode(initialMode);

    this.renderer = createRenderer(container, {
      state: this.state,
      settings: this.host.settings,
      onNodeClick: (atom) => this.openAtom(atom),
      layout: this.host.settings.defaultLayout,
    });

    if (this.host.settings.showScrubber) {
      const scrubberHost = container.ownerDocument.createElement('div');
      scrubberHost.classList.add('mk-graph-scrubber-host');
      container.appendChild(scrubberHost);
      this.scrubber = createScrubber(scrubberHost, {
        fromIso: '1970-01-01T00:00:00Z',
        toIso: new Date().toISOString(),
        initialMode,
        initialPlayheadIso: this.host.settings.lastScrubbedAt ?? new Date().toISOString(),
        onModeChange: (mode) => this.handleModeChange(mode),
        onPlayheadChange: (iso) => this.handlePlayheadChange(iso),
      });
    }

    // Mount the filter panel inside the renderer's body-attached overlay
    // layer so it's positioned in screen space and not clobbered by
    // force-graph (same trick as the legend / tooltip — see renderer.ts).
    const overlayLayer = container.ownerDocument.body.querySelector<HTMLElement>('.mk-graph-overlay-layer');
    if (overlayLayer) {
      this.filterPanel = createFilterPanel(overlayLayer, {
        initialState: this.filterState,
        availableTags: [],
        onChange: (s) => this.handleFilterChange(s),
      });
      // Defensive sync: createFilterPanel already initialises from
      // this.filterState, but calling setState explicitly establishes
      // the contract that any future code path mutating this.filterState
      // outside the panel's onChange should also call setState to keep
      // the panel's checkboxes / search input / chip selection in sync.
      this.filterPanel.setState(this.filterState);
      this.filterPanel.setVisible(this.host.settings.showFilterPanel);
    }

    await this.reloadFromDisk();

    const memDir = this.resolveMemoryDirAbsolute();
    if (memDir) {
      this.watcher = watchVault(memDir, () => { void this.reloadFromDisk(); });
      this.eventsWatcher = watchEvents(memDir, () => { void this.reloadEvents(); });
    }
  }

  async onClose(): Promise<void> {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.eventsWatcher) { this.eventsWatcher.close(); this.eventsWatcher = null; }
    if (this.scrubber) { this.scrubber.destroy(); this.scrubber = null; }
    if (this.filterPanel) { this.filterPanel.destroy(); this.filterPanel = null; }
    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    this.controller = null;
  }

  /** Public so the plugin entry can call it from the "Reload" command.
   *  Catches directory-level read errors so a watcher-fired reload after
   *  the user deletes the memory dir doesn't surface as an unhandled
   *  promise rejection. Per-file errors are already swallowed by readVault. */
  async reloadFromDisk(): Promise<void> {
    try {
      const memDir = this.resolveMemoryDirAbsolute();
      if (!memDir) {
        this.controller?.setFallbackAtoms([]);
        this.controller?.setEvents([]);
        this.events = [];
        return;
      }
      const [atoms, events] = await Promise.all([readVault(memDir), readEvents(memDir)]);
      this.events = events;
      this.controller?.setFallbackAtoms(atoms);
      this.controller?.setEvents(events);
      this.applyEventRangeToScrubber(events);
    } catch (err) {
      console.warn('mk-graph: reloadFromDisk failed', err);
      this.controller?.setFallbackAtoms([]);
      this.controller?.setEvents([]);
    }
  }

  private async reloadEvents(): Promise<void> {
    const memDir = this.resolveMemoryDirAbsolute();
    if (!memDir) return;
    const events = await readEvents(memDir);
    this.events = events;
    this.controller?.setEvents(events);
    this.applyEventRangeToScrubber(events);
  }

  /** Re-anchor the scrubber's slider range and histogram to the loaded events.
   *  Both span exactly `[events.first, events.last]` so the slider track and
   *  the histogram are visually the same length and represent the same time
   *  range. Live-mode "now" maps to slider value 1000 (the right end) via
   *  setPlayhead's clamp — the readout still shows the actual current time. */
  private applyEventRangeToScrubber(events: PluginEvent[]): void {
    if (!this.scrubber) return;
    const range = this.eventTimestampRange(events);
    if (!range) return;
    this.scrubber.setRange(range.from, range.to);
    this.scrubber.setHistogram(computeHistogram(events, range.from, range.to));
  }

  private eventTimestampRange(events: PluginEvent[]): { from: string; to: string } | null {
    if (events.length === 0) return null;
    let from = events[0].timestamp;
    let to = events[0].timestamp;
    for (const e of events) {
      if (e.timestamp < from) from = e.timestamp;
      if (e.timestamp > to) to = e.timestamp;
    }
    return { from, to };
  }

  private handleModeChange(mode: ReplayMode): void {
    this.controller?.setMode(mode);
    if (mode === 'scrubbed' || mode === 'diff') {
      if (this.host.settings.liveModeOnStartup) {
        this.host.settings.liveModeOnStartup = false;
        void this.host.saveSettings();
      }
    }
    // When entering Diff with the playhead at the right end (T1 == T2 →
    // empty diff), snap the playhead to the earliest event so the user
    // immediately sees a meaningful "full history" diff. They can drag
    // right to narrow the window; the right end shows no diff.
    if (mode === 'diff' && this.events.length > 0) {
      const range = this.eventTimestampRange(this.events);
      const last = this.host.settings.lastScrubbedAt;
      if (range && (!last || last >= range.to)) {
        this.controller?.setPlayhead(range.from);
        this.scrubber?.setPlayhead(range.from);
        this.host.settings.lastScrubbedAt = range.from;
        void this.host.saveSettings();
      }
    }
  }

  private handlePlayheadChange(iso: string): void {
    // Defensive guard: only persist playhead values inside the events range.
    // The slider itself is now constrained by setRange() so this should be a
    // no-op in practice, but it protects against a pre-load drag firing
    // before the first applyEventRangeToScrubber() call.
    const range = this.eventTimestampRange(this.events);
    if (range && iso < range.from) return;
    this.controller?.setPlayhead(iso);
    this.host.settings.lastScrubbedAt = iso;
    void this.host.saveSettings();
  }

  /** Public — invoked by the "Toggle filter panel" command. */
  setFilterPanelVisible(visible: boolean): void {
    this.filterPanel?.setVisible(visible);
  }

  /** Public — invoked by the "Toggle Live / Scrubbed mode" command. */
  toggleLiveScrubbed(): void {
    if (!this.controller) return;
    const active = this.scrubber
      ? (this.containerEl.querySelector('.mk-graph-scrubber-mode-btn.is-active') as HTMLButtonElement | null)
      : null;
    const next: ReplayMode = active?.dataset.mode === 'live' ? 'scrubbed' : 'live';
    this.handleModeChange(next);
    this.scrubber?.setMode(next);
  }

  /** Computes the set of atom ids referenced (as relation targets) by
   *  any other atom in the supplied list. Used by the orphans filter. */
  private computeReferencedSet(atoms: ParsedAtom[]): Set<string> {
    const ref = new Set<string>();
    for (const a of atoms) {
      for (const r of a.relations) ref.add(r.target);
    }
    return ref;
  }

  /** Sorted unique tag set across the supplied atoms — used to populate
   *  the filter panel's tag chips. */
  private collectTags(atoms: ParsedAtom[]): string[] {
    const set = new Set<string>();
    for (const a of atoms) for (const t of a.tags) set.add(t);
    return [...set].sort();
  }

  /** Filter-panel onChange callback. Stores the new state, persists it,
   *  and triggers a re-emit so the graph re-renders with the new filter
   *  applied without waiting for the next file change. */
  private handleFilterChange(newState: FilterState): void {
    this.filterState = newState;
    this.host.settings.filters = serializeFilterState(newState);
    void this.host.saveSettings();
    // Re-emit the controller's current state so the renderer picks up
    // the new filter on the next animation frame. Cheap because the
    // replay engine memoises and the controller has no I/O.
    if (this.controller) {
      const current = this.controller.current();
      const referenced = this.computeReferencedSet(current.atoms);
      const filtered = current.atoms.filter((a) =>
        matchesFilter(a, this.filterState, (id) => referenced.has(id)),
      );
      this.state.replace(filtered);
      this.renderer?.setDiff(current.diff);
    }
  }

  private resolveMemoryDirAbsolute(): string | null {
    const { memoryDir, memoryDirOutsideVault, agentId } = this.host.settings;
    if (!memoryDir) return null;

    let base: string;
    if (path.isAbsolute(memoryDir)) {
      if (!memoryDirOutsideVault) {
        console.warn(
          `mk-graph: memoryDir "${memoryDir}" is absolute but "memoryDirOutsideVault" is off. Skipping load.`,
        );
        return null;
      }
      base = memoryDir;
    } else {
      const vaultRoot = (this.host.app.vault.adapter as { basePath?: string }).basePath;
      if (!vaultRoot) {
        console.warn('mk-graph: cannot resolve vault root; skipping load.');
        return null;
      }
      base = path.join(vaultRoot, normalizePath(memoryDir));
    }

    return resolveMemoryDir(base, agentId || undefined);
  }

  private async openAtom(atom: ParsedAtom): Promise<void> {
    if (!atom.filePath) return;
    const vaultRoot = (this.host.app.vault.adapter as { basePath?: string }).basePath;
    if (!vaultRoot) return;
    let rel = atom.filePath;
    if (rel.startsWith(vaultRoot)) {
      rel = rel.slice(vaultRoot.length).replace(/^[/\\]+/, '');
    } else {
      // Atom lives outside the vault (likely memoryDirOutsideVault=true).
      // Obsidian can't open files it doesn't know about — surface a Notice
      // so the click doesn't silently fail.
      new Notice(
        `mk-graph: atom is outside the vault (${atom.filePath}); Obsidian can only open files inside the vault.`,
      );
      return;
    }

    // Obsidian skips dot-folders during vault indexing, so files inside
    // them (e.g. the conventional `.mk/` memory dir) aren't reachable via
    // openLinkText — the call falls through to "create a new file" and
    // collides with the existing folder. Detect and warn rather than fail
    // silently with "Folder already exists".
    if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) {
      new Notice(
        `mk-graph: atom path "${rel}" is in a dot-folder. Obsidian doesn't index dot-folders, so it can't open the file. Move or rename the memory directory (e.g. "memory" instead of ".mk") to make atoms clickable.`,
      );
      return;
    }

    // Open in a new tab so the graph view stays visible alongside the atom.
    await this.host.app.workspace.openLinkText(normalizePath(rel), '', 'tab');
  }
}
