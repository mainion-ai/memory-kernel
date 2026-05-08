import type { ParsedAtom } from './atom-parser.js';

export interface TooltipHandle {
  show(atom: ParsedAtom, x: number, y: number, citations: number): void;
  hide(): void;
  destroy(): void;
}

/**
 * Mount a singleton tooltip element inside `container` and return handles
 * to drive it. The element is positioned absolutely inside the container,
 * so the container needs `position: relative` (set in styles.css for
 * `.mk-graph-view-container`).
 */
export function createTooltip(container: HTMLElement): TooltipHandle {
  const el = container.ownerDocument.createElement('div');
  el.classList.add('mk-graph-tooltip');
  container.appendChild(el);

  function show(atom: ParsedAtom, x: number, y: number, citations: number): void {
    el.empty();
    const id = el.createDiv({ cls: 'mk-graph-tooltip-id' });
    id.setText(atom.id);

    const title = el.createDiv({ cls: 'mk-graph-tooltip-title' });
    title.setText(`${atom.type} · ${atom.status}`);

    const meta = el.createDiv({ cls: 'mk-graph-tooltip-meta' });
    // Each meta field gets its own line for readability — previously the
    // fields were `·`-separated on a single wrapping line which made
    // longer atoms hard to scan at a glance.
    meta.createDiv({ cls: 'mk-graph-tooltip-meta-row', text: `classification: ${atom.classification}` });
    meta.createDiv({ cls: 'mk-graph-tooltip-meta-row', text: `citations: ${citations}` });
    if (atom.tags.length > 0) {
      meta.createDiv({ cls: 'mk-graph-tooltip-meta-row', text: `tags: ${atom.tags.slice(0, 4).join(', ')}` });
    }

    el.style.left = `${x + 12}px`;
    el.style.top = `${y + 12}px`;
    el.classList.add('is-visible');
  }

  function hide(): void {
    el.classList.remove('is-visible');
  }

  function destroy(): void {
    el.remove();
  }

  return { show, hide, destroy };
}
