import {
  TYPE_COLORS,
  RELATION_COLORS,
  CLASSIFICATION_BORDERS,
  SOURCE_DASH,
  STATUS_OPACITY,
  SECRET_GLYPH,
} from './visual.js';

export interface LegendHandle {
  setVisible(visible: boolean): void;
  destroy(): void;
}

/**
 * Mount a static F2-encoding legend in the bottom-left of `container`.
 * Reads the visual constants directly from `visual.ts` so it stays in
 * sync with the renderer's encoding choices. Pure DOM — no force-graph
 * dependency, so it doesn't depend on the (currently flaky) hover path.
 */
export function createLegend(container: HTMLElement, opts: { visible: boolean }): LegendHandle {
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.classList.add('mk-graph-legend');
  if (!opts.visible) root.classList.add('is-hidden');

  // Header — collapsible toggle
  const header = root.createDiv({ cls: 'mk-graph-legend-header' });
  header.createSpan({ cls: 'mk-graph-legend-title', text: 'Legend' });
  const toggle = header.createSpan({ cls: 'mk-graph-legend-toggle', text: '▾' });
  let collapsed = false;
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    toggle.setText(collapsed ? '▸' : '▾');
  });

  const body = root.createDiv({ cls: 'mk-graph-legend-body' });

  // Atom types
  appendSection(body, 'Type (fill)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-swatch' });
      swatch.style.background = color;
      item.createSpan({ cls: 'mk-graph-legend-label', text: type });
    }
    return list;
  });

  // Classification (border)
  appendSection(body, 'Classification (ring)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    for (const [cls, color] of Object.entries(CLASSIFICATION_BORDERS)) {
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-ring' });
      swatch.style.borderColor = color;
      const label = cls === 'SECRET' ? `${cls} ${SECRET_GLYPH}` : cls;
      item.createSpan({ cls: 'mk-graph-legend-label', text: label });
    }
    return list;
  });

  // Status (opacity)
  appendSection(body, 'Status (opacity)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    for (const [status, opacity] of Object.entries(STATUS_OPACITY)) {
      if (opacity === 0) continue; // expired hidden — don't list
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-swatch mk-graph-legend-swatch-mono' });
      swatch.style.opacity = String(opacity);
      item.createSpan({ cls: 'mk-graph-legend-label', text: `${status} (${opacity})` });
    }
    return list;
  });

  // Relations (color)
  appendSection(body, 'Relation (edge color)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    for (const [rel, color] of Object.entries(RELATION_COLORS)) {
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-line' });
      swatch.style.background = color;
      item.createSpan({ cls: 'mk-graph-legend-label', text: rel });
    }
    return list;
  });

  // Edge source (dash pattern)
  appendSection(body, 'Source (edge dash)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    const labels: Record<string, string> = {
      manual: 'manual (solid)',
      extracted: 'extracted (dashed)',
      enriched: 'enriched (dotted)',
      unknown: 'unknown (solid, thin)',
    };
    for (const [src, dash] of Object.entries(SOURCE_DASH)) {
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-line' });
      const dashArr = dash as ReadonlyArray<number>;
      if (dashArr.length === 0) {
        swatch.style.background = 'currentColor';
      } else {
        // Render dash via repeating-linear-gradient
        const onLen = dashArr[0];
        const offLen = dashArr[1] ?? 3;
        swatch.style.background = `repeating-linear-gradient(to right, currentColor 0 ${onLen}px, transparent ${onLen}px ${onLen + offLen}px)`;
      }
      // Visualize "thin" by halving the swatch height for the unknown
      // source — matches edgeWidth's 0.5× scaling for `source: 'unknown'`.
      if (src === 'unknown') swatch.style.height = '1px';
      item.createSpan({ cls: 'mk-graph-legend-label', text: labels[src] ?? src });
    }
    return list;
  });

  // Citation count (size)
  appendSection(body, 'Size = log(citations)', () => {
    const list = doc.createElement('div');
    list.classList.add('mk-graph-legend-list');
    for (const [label, radius] of [
      ['few citations', 5],
      ['some citations', 10],
      ['many citations', 16],
    ] as const) {
      const item = list.createDiv({ cls: 'mk-graph-legend-item' });
      const swatch = item.createSpan({ cls: 'mk-graph-legend-circle' });
      swatch.style.width = `${radius * 2}px`;
      swatch.style.height = `${radius * 2}px`;
      item.createSpan({ cls: 'mk-graph-legend-label', text: label });
    }
    return list;
  });

  container.appendChild(root);

  return {
    setVisible(visible: boolean): void {
      if (visible) root.classList.remove('is-hidden');
      else root.classList.add('is-hidden');
    },
    destroy(): void {
      root.remove();
    },
  };
}

function appendSection(parent: HTMLElement, title: string, build: () => HTMLElement): void {
  const section = parent.createDiv({ cls: 'mk-graph-legend-section' });
  section.createDiv({ cls: 'mk-graph-legend-section-title', text: title });
  section.appendChild(build());
}
