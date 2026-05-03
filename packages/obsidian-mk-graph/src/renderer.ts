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

export interface RendererOpts {
  state: GraphState;
  settings: MkGraphSettings;
  onNodeClick: (atom: ParsedAtom) => void;
}

export interface RendererHandle {
  destroy(): void;
}

/**
 * Mount a force-graph renderer into `container`. Returns a handle that
 * cleans up the subscription, the resize observer, and the force-graph
 * canvas on `destroy()`. Caller is responsible for calling `destroy()`
 * before unmounting the container (the view does this in `onClose`).
 */
export function createRenderer(container: HTMLElement, opts: RendererOpts): RendererHandle {
  const tooltip: TooltipHandle = createTooltip(container);
  const legend: LegendHandle = createLegend(container, { visible: opts.settings.showLegend });
  const containerStyle = getComputedStyle(container);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fg: any = (ForceGraph as any)()(container);
  /* eslint-enable @typescript-eslint/no-explicit-any */

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
    fg.graphData(data);
  }

  fg.nodeCanvasObjectMode(() => 'replace');
  fg.nodeCanvasObject((rawNode: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode;
    const baseRadius = opts.settings.nodeChannels.size
      ? f2NodeSize(citations.get(node.id) ?? 0)
      : 6;
    const opacity = opts.settings.nodeChannels.opacity ? f2NodeOpacity(node) : 1.0;
    if (opacity <= 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, baseRadius, 0, 2 * Math.PI);
    ctx.fillStyle = f2NodeColor(node);
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
    return hexToRgba(f2EdgeColor(rel), f2EdgeOpacity(rel));
  });
  fg.linkWidth((link: GraphLink) => f2EdgeWidth(linkAsRelation(link)));
  fg.linkLineDash((link: GraphLink) => [...f2EdgeDash(linkAsRelation(link))]);
  // No linkOpacity — force-graph 1.x doesn't expose one; alpha baked into linkColor's rgba.

  fg.onNodeHover((node: GraphNode | null, _prev: GraphNode | null) => {
    if (!node) {
      tooltip.hide();
      container.style.cursor = '';
      return;
    }
    container.style.cursor = 'pointer';
    const screen = fg.graph2ScreenCoords(node.x ?? 0, node.y ?? 0);
    tooltip.show(node, screen.x, screen.y, citations.get(node.id) ?? 0);
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
    destroy(): void {
      unsubscribe();
      resizeObserver.disconnect();
      tooltip.destroy();
      legend.destroy();
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
