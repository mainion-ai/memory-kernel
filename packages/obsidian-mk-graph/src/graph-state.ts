import type { ParsedAtom, ParsedRelation } from './atom-parser.js';

/** force-graph node shape — mirrors `ParsedAtom` plus `id` (force-graph requires `id`). */
export interface GraphNode extends ParsedAtom {
  // force-graph mutates these; declared here so TS allows them.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Pinned position. When set, force-graph treats the node as fixed.
   *  Used by the timeline layout. Cleared by the force layout. */
  fx?: number;
  fy?: number;
}

/** Force-graph link shape. `source` and `target` are atom IDs in the
 *  input we hand to force-graph; force-graph mutates them to node-object
 *  references on the first simulation tick, so post-tick consumers should
 *  treat them as `string | GraphNode`. The provenance (manual / extracted /
 *  enriched) is carried in `source_kind` because force-graph already owns
 *  the field name `source`. */
export interface GraphLink {
  source: string;
  target: string;
  type: string;
  confidence?: number;
  weight?: number;
  source_kind?: string;
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
    // Shallow spread: force-graph only mutates x/y/vx/vy on the node, never
    // walks `relations`, so sharing the relation array reference is safe.
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

  /** Sorted unique set of tags across all loaded atoms. Used by the
   *  filter panel to populate tag chips. Empty array when there are no
   *  atoms or no atoms have tags. */
  getAvailableTags(): string[] {
    const tags = new Set<string>();
    for (const a of this.atoms.values()) {
      for (const t of a.tags) tags.add(t);
    }
    return [...tags].sort();
  }

  /** Set of atom ids that are referenced as relation targets by some
   *  other atom. Used by the filter panel's "orphans only" mode to
   *  detect atoms with zero inbound references. O(total relations). */
  getReferencedIds(): Set<string> {
    const refs = new Set<string>();
    for (const rels of this.outboundIndex.values()) {
      for (const r of rels) refs.add(r.target);
    }
    return refs;
  }
}
