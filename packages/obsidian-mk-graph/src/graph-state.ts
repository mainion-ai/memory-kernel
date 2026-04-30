import type { ParsedAtom, ParsedRelation } from './atom-parser.js';

/** force-graph node shape — mirrors `ParsedAtom` plus `id` (force-graph requires `id`). */
export interface GraphNode extends ParsedAtom {
  // force-graph mutates these; declared here so TS allows them.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
  confidence?: number;
  weight?: number;
  source_kind?: string;   // renamed to avoid colliding with force-graph's `source` field semantics
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export type Subscriber = () => void;

/**
 * Observable graph state. Single source of truth shared by DataLoader
 * (writer) and Renderer (reader). All mutations go through `replace()`
 * which fires every subscriber; subscribers debounce / re-render as
 * appropriate.
 */
export class GraphState {
  readonly atoms: Map<string, ParsedAtom> = new Map();
  private readonly outboundIndex: Map<string, ParsedRelation[]> = new Map();
  private readonly subscribers: Set<Subscriber> = new Set();

  /** Replace the entire atom set. Callers should pass a fresh array. */
  replace(atoms: ParsedAtom[]): void {
    this.atoms.clear();
    this.outboundIndex.clear();
    for (const a of atoms) {
      this.atoms.set(a.id, a);
      if (a.relations.length > 0) {
        this.outboundIndex.set(a.id, a.relations);
      }
    }
    for (const fn of this.subscribers) fn();
  }

  outbound(id: string): ParsedRelation[] {
    return this.outboundIndex.get(id) ?? [];
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Produce a force-graph-compatible {nodes, links} snapshot.
   * Drops links whose target atom isn't loaded — keeps the renderer from
   * synthesizing phantom nodes for dangling references.
   */
  toGraphData(): GraphData {
    const nodes: GraphNode[] = Array.from(this.atoms.values()).map((a) => ({ ...a }));
    const links: GraphLink[] = [];
    for (const [sourceId, rels] of this.outboundIndex) {
      for (const rel of rels) {
        if (!this.atoms.has(rel.target)) continue;
        const link: GraphLink = {
          source: sourceId,
          target: rel.target,
          type: rel.type,
        };
        if (rel.confidence !== undefined) link.confidence = rel.confidence;
        if (rel.weight !== undefined) link.weight = rel.weight;
        if (rel.source !== undefined) link.source_kind = rel.source;
        links.push(link);
      }
    }
    return { nodes, links };
  }
}
