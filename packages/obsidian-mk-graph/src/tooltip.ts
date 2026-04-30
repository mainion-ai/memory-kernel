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
    const lines: string[] = [];
    lines.push(`classification: ${atom.classification}`);
    lines.push(`citations: ${citations}`);
    if (atom.tags.length > 0) lines.push(`tags: ${atom.tags.slice(0, 4).join(', ')}`);
    meta.setText(lines.join(' · '));

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
