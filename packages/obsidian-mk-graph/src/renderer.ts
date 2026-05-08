import ForceGraph from 'force-graph';
import { GraphState, type GraphNode, type GraphLink } from './graph-state.js';
import {
  nodeColor as f2NodeColor,
  nodeSize as f2NodeSize,
  nodeBorderColor as f2NodeBorderColor,
  nodeOpacity as f2NodeOpacity,
  edgeColor as f2EdgeColor,
  edgeWidth as f2EdgeWidth,
  edgeDash as f2EdgeDash,
  edgeOpacity as f2EdgeOpacity,
} from './encoding.js';
import { countIncomingCitations } from './citations.js';
import type { MkGraphSettings } from './settings.js';
import { createTooltip, type TooltipHandle } from './tooltip.js';
import { createLegend, type LegendHandle } from './legend.js';
import { SECRET_GLYPH } from './visual.js';
import { hexToRgba } from './color.js';
import type { ParsedAtom, ParsedRelation } from './atom-parser.js';
import { applyLayout, type LayoutKind } from './layout.js';
import { diffNodeColor, diffNodeOpacity, diffEdgeColor } from './diff-overlay.js';
import type { DiffSet } from './diff-state.js';

export interface RendererOpts {
  state: GraphState;
  settings: MkGraphSettings;
  onNodeClick: (atom: ParsedAtom) => void;
  /** Initial layout. Defaults to settings.defaultLayout. */
  layout?: LayoutKind;
  /** Visible time range used by the timeline layout. Falls back to
   *  the createdAt min/max of the loaded atoms when omitted. */
  fromIso?: string;
  toIso?: string;
  /** When set, renders in Diff mode with overlay colors. */
  diff?: DiffSet;
}

export interface RendererHandle {
  setLayout(kind: LayoutKind, fromIso?: string, toIso?: string): void;
  setDiff(diff: DiffSet | undefined): void;
  destroy(): void;
}

/**
 * Mount a force-graph renderer into `container`. Returns a handle that
 * cleans up the subscription, the resize observer, and the force-graph
 * canvas on `destroy()`. Caller is responsible for calling `destroy()`
 * before unmounting the container (the view does this in `onClose`).
 *
 * DOM layout produced:
 * ```
 * container (position: relative — the leaf content area)
 * └── force-graph-container       (force-graph mounts here exclusively;
 *                                  it clears any siblings async during init)
 *
 * document.body
 * └── .mk-graph-overlay-layer     (position: fixed, size tracks container
 *                                  via ResizeObserver + window listeners)
 *     ├── .mk-graph-tooltip       (position: absolute inside overlay)
 *     └── .mk-graph-legend        (position: absolute inside overlay)
 * ```
 *
 * The overlay layer lives in `document.body` rather than the leaf container
 * because force-graph's init in Obsidian's Electron renderer clobbers
 * sibling children (verified by v0.1.6 console diagnostic). Body attachment
 * is force-graph-proof. Don't move overlays back into the container without
 * verifying tooltip + legend visibility against a live Obsidian instance.
 */
export function createRenderer(container: HTMLElement, opts: RendererOpts): RendererHandle {
  const containerStyle = getComputedStyle(container);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fg: any = (ForceGraph as any)()(container);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Mount our overlays in a layer attached to document.body (NOT the
  // graph container) because force-graph's mount sequence in Obsidian's
  // Electron renderer ends up clobbering siblings — a v0.1.6 console
  // diagnostic showed the container had only force-graph's wrapper as a
  // child even after an explicit appendChild of the overlay. Working
  // theory: force-graph defers DOM setup to after our synchronous code
  // returns and clears the container as part of its init.
  //
  // Position: fixed in body with size + position tracked against the
  // container's getBoundingClientRect.
  const doc = container.ownerDocument;
  const overlayLayer = doc.createElement('div');
  overlayLayer.classList.add('mk-graph-overlay-layer');
  try {
    doc.body.appendChild(overlayLayer);
  } catch (e) {
    // Extremely rare — body should always exist by the time the view opens.
    console.warn('mk-graph: failed to attach overlay to document.body', e);
  }

  const updateOverlayPosition = (): void => {
    const rect = container.getBoundingClientRect();
    overlayLayer.style.left = `${rect.left}px`;
    overlayLayer.style.top = `${rect.top}px`;
    overlayLayer.style.width = `${rect.width}px`;
    overlayLayer.style.height = `${rect.height}px`;
  };
  updateOverlayPosition();
  const overlayResizeObserver = new ResizeObserver(updateOverlayPosition);
  overlayResizeObserver.observe(container);
  window.addEventListener('resize', updateOverlayPosition);
  window.addEventListener('scroll', updateOverlayPosition, true); // capture: catches nested scrolls

  const tooltip: TooltipHandle = createTooltip(overlayLayer);
  const legend: LegendHandle = createLegend(overlayLayer, { visible: opts.settings.showLegend });

  // The legend lives at `bottom: 12px` by default; the scrubber occupies
  // `bottom: 0` with height 92px. When both are mounted, push the legend
  // up so it clears the scrubber. Phase 2 (scrubber off) keeps the
  // original positioning.
  if (opts.settings.showScrubber) {
    const legendEl = overlayLayer.querySelector('.mk-graph-legend');
    legendEl?.classList.add('with-scrubber-clearance');
  }

  // Hide the overlay-layer (legend + tooltip) when an Obsidian modal is
  // open. Without this, the overlay's z-index 9999 sits on top of the
  // settings / preferences modal and obscures it.
  const updateModalSuppression = (): void => {
    const modalOpen = doc.body.classList.contains('is-modal-open')
      || doc.body.querySelector('.modal-container .modal') !== null;
    overlayLayer.classList.toggle('is-modal-suppressed', modalOpen);
  };
  updateModalSuppression();
  const modalObserver = new MutationObserver(updateModalSuppression);
  modalObserver.observe(doc.body, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: false, // body's direct children — modal-container is one of them
  });

  fg.backgroundColor('rgba(0,0,0,0)');
  fg.nodeRelSize(1);
  // force-graph uses sqrt(val) * nodeRelSize for force-layout sizing
  // (collision radius, link distance scaling). Keep val accurate for that
  // even though hit-testing now goes through nodePointerAreaPaint below.
  fg.nodeVal((node: GraphNode) => {
    const radius = opts.settings.nodeChannels.size
      ? f2NodeSize(citations.get(node.id) ?? 0)
      : 6;
    return radius * radius;
  });
  // nodeCanvasObjectMode('replace') tells force-graph we paint visuals
  // ourselves — but it ALSO disables the default hit-test mask, so we
  // must paint an explicit pointer-area shape too. Without this,
  // onNodeHover never fires regardless of nodeVal.
  fg.nodePointerAreaPaint((node: GraphNode, color: string, ctx: CanvasRenderingContext2D) => {
    const radius = opts.settings.nodeChannels.size
      ? f2NodeSize(citations.get(node.id) ?? 0)
      : 6;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  });
  fg.linkDirectionalArrowLength(0); // arrows added in Phase 4 if useful
  fg.cooldownTicks(120);

  let citations = new Map<string, number>();
  let firstNonEmptyRender = true;

  let currentLayout: LayoutKind = opts.layout ?? opts.settings.defaultLayout ?? 'force';
  let currentFromIso: string | undefined = opts.fromIso;
  let currentToIso: string | undefined = opts.toIso;
  let currentDiff: DiffSet | undefined = opts.diff;

  function rangeFromAtoms(atoms: GraphNode[]): { from: string; to: string } {
    let min = '';
    let max = '';
    for (const a of atoms) {
      if (!a.createdAt) continue;
      if (!min || a.createdAt < min) min = a.createdAt;
      if (!max || a.createdAt > max) max = a.createdAt;
    }
    if (!min) {
      const now = new Date().toISOString();
      return { from: now, to: now };
    }
    return { from: min, to: max };
  }

  function applyData(): void {
    const data = opts.state.toGraphData();
    if (data.nodes.length > opts.settings.maxNodesShown) {
      citations = countIncomingCitations(data.nodes);
      data.nodes.sort((a, b) => (citations.get(b.id) ?? 0) - (citations.get(a.id) ?? 0));
      data.nodes.length = opts.settings.maxNodesShown;
      const keep = new Set(data.nodes.map((n) => n.id));
      data.links = data.links.filter((l) => keep.has(l.source) && keep.has(l.target));
    } else {
      citations = countIncomingCitations(data.nodes);
    }

    const fallback = rangeFromAtoms(data.nodes);
    const fromIso = currentFromIso ?? fallback.from;
    const toIso = currentToIso ?? fallback.to;
    const rect = container.getBoundingClientRect();
    applyLayout(data.nodes, {
      kind: currentLayout,
      width: Math.max(100, rect.width),
      height: Math.max(100, rect.height),
      fromIso,
      toIso,
    });

    fg.graphData(data);

    // Force layout: warm the simulation. Timeline: freeze.
    if (currentLayout === 'force') {
      fg.cooldownTicks(120);
      fg.resumeAnimation?.();
    } else {
      fg.cooldownTicks(0);
      fg.pauseAnimation?.();
    }

    // Auto-zoom-to-fit on the first non-empty render so a single-atom
    // store (e.g. an agent dir with one file) doesn't render as a tiny
    // dot at canvas origin. Force layout: wait for the simulation to
    // settle first; timeline: positions are pinned, fit immediately.
    if (firstNonEmptyRender && data.nodes.length > 0) {
      firstNonEmptyRender = false;
      const fitDelay = currentLayout === 'force' ? 600 : 0;
      setTimeout(() => fg.zoomToFit?.(400, 60), fitDelay);
    }
  }

  fg.nodeCanvasObjectMode(() => 'replace');
  fg.nodeCanvasObject((rawNode: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode;
    const baseRadius = opts.settings.nodeChannels.size
      ? f2NodeSize(citations.get(node.id) ?? 0)
      : 6;
    let opacity = opts.settings.nodeChannels.opacity ? f2NodeOpacity(node) : 1.0;
    if (currentDiff) opacity = diffNodeOpacity(currentDiff.classify(node.id), opacity);
    if (opacity <= 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, baseRadius, 0, 2 * Math.PI);
    const baseColor = f2NodeColor(node);
    ctx.fillStyle = currentDiff ? diffNodeColor(currentDiff.classify(node.id), baseColor) : baseColor;
    ctx.fill();

    if (opts.settings.nodeChannels.border) {
      ctx.lineWidth = Math.max(1, baseRadius * 0.18);
      ctx.strokeStyle = f2NodeBorderColor(node);
      ctx.stroke();
    }

    if (node.classification === 'SECRET') {
      const fontSize = Math.max(8, baseRadius * 0.9);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(SECRET_GLYPH, node.x ?? 0, node.y ?? 0);
    }

    if (globalScale > 1.5) {
      const labelSize = 10 / globalScale;
      ctx.font = `${labelSize}px sans-serif`;
      ctx.fillStyle = containerStyle.getPropertyValue('--text-normal').trim() || '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.id, node.x ?? 0, (node.y ?? 0) + baseRadius + 2);
    }
    ctx.restore();
  });

  fg.linkColor((link: GraphLink) => {
    const rel = linkAsRelation(link);
    const baseHex = f2EdgeColor(rel);
    const baseAlpha = f2EdgeOpacity(rel);
    if (!currentDiff) return hexToRgba(baseHex, baseAlpha);
    const sId = typeof link.source === 'string' ? link.source : (link.source as GraphNode).id;
    const tId = typeof link.target === 'string' ? link.target : (link.target as GraphNode).id;
    const overlayHex = diffEdgeColor(currentDiff.classify(sId), currentDiff.classify(tId), baseHex);
    return hexToRgba(overlayHex, baseAlpha);
  });
  fg.linkWidth((link: GraphLink) => f2EdgeWidth(linkAsRelation(link)));
  fg.linkLineDash((link: GraphLink) => [...f2EdgeDash(linkAsRelation(link))]);
  // No linkOpacity — force-graph 1.x doesn't expose one; alpha baked into linkColor's rgba.

  // Track the latest cursor position in container-local coordinates so the
  // tooltip can be placed at the cursor on hover. Avoids graph2ScreenCoords,
  // whose reference frame in Obsidian's Electron renderer is unreliable
  // (force-graph wraps the canvas in its own div with positioning that
  // doesn't always match the container origin).
  let lastCursorX = 0;
  let lastCursorY = 0;
  const onMouseMove = (ev: MouseEvent): void => {
    const rect = container.getBoundingClientRect();
    lastCursorX = ev.clientX - rect.left;
    lastCursorY = ev.clientY - rect.top;
  };
  container.addEventListener('mousemove', onMouseMove);

  fg.onNodeHover((node: GraphNode | null, _prev: GraphNode | null) => {
    if (!node) {
      tooltip.hide();
      container.style.cursor = '';
      return;
    }
    container.style.cursor = 'pointer';
    tooltip.show(node, lastCursorX, lastCursorY, citations.get(node.id) ?? 0);
  });

  fg.onNodeClick((node: GraphNode) => {
    opts.onNodeClick(node);
  });

  const unsubscribe = opts.state.subscribe(applyData);
  applyData();

  const resizeObserver = new ResizeObserver(() => {
    fg.width(container.clientWidth);
    fg.height(container.clientHeight);
  });
  resizeObserver.observe(container);
  fg.width(container.clientWidth);
  fg.height(container.clientHeight);

  return {
    setLayout(kind: LayoutKind, fromIso?: string, toIso?: string): void {
      currentLayout = kind;
      currentFromIso = fromIso;
      currentToIso = toIso;
      applyData();
    },
    setDiff(diff: DiffSet | undefined): void {
      currentDiff = diff;
      // force-graph re-paints on its next animation frame; the closure
      // updates above are picked up automatically. No graphData call needed
      // because the data itself didn't change.
      fg.refresh?.();
    },
    destroy(): void {
      container.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', updateOverlayPosition);
      window.removeEventListener('scroll', updateOverlayPosition, true);
      overlayResizeObserver.disconnect();
      modalObserver.disconnect();
      unsubscribe();
      resizeObserver.disconnect();
      tooltip.destroy();
      legend.destroy();
      overlayLayer.remove(); // safe even though it's in body, not container
      fg._destructor?.();
      while (container.firstChild) container.removeChild(container.firstChild);
    },
  };
}

function linkAsRelation(link: GraphLink): ParsedRelation {
  const rel: ParsedRelation = { target: link.target, type: link.type };
  if (link.confidence !== undefined) rel.confidence = link.confidence;
  if (link.weight !== undefined) rel.weight = link.weight;
  if (link.source_kind !== undefined) rel.source = link.source_kind;
  return rel;
}
