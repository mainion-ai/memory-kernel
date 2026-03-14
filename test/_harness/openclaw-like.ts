/**
 * OpenClaw-like tool harness (no OpenClaw dependency).
 *
 * Why this exists:
 * - OpenClaw live testing surfaced "mk_recall broken" reports.
 * - In this repo, the OpenClaw plugin lives under packages/openclaw-memory-kernel,
 *   but that package has its own dependency graph (TypeBox, etc.). Root tests should
 *   remain runnable without installing that subpackage.
 *
 * This harness provides a minimal "registerTool + execute" surface so we can:
 * - reproduce OpenClaw-style workflows (mk_remember -> mk_recall)
 * - write deterministic integration tests over the memory-kernel substrate
 * - catch policy surprises (classification exclusions, missing reindex, etc.)
 */

export type ToolExecute = (id: string, params: any) => Promise<any> | any;

export interface ToolDef {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: ToolExecute;
}

export class FakeToolApi {
  private tools = new Map<string, ToolDef>();

  registerTool(def: ToolDef): void {
    if (!def?.name) throw new Error('registerTool: missing tool name');
    if (typeof def.execute !== 'function') throw new Error(`registerTool(${def.name}): missing execute()`);
    this.tools.set(def.name, def);
  }

  getTool(name: string): ToolDef {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool not registered: ${name}`);
    return t;
  }
}

export function stringifyResult(res: any): string {
  if (typeof res === 'string') return res;
  try {
    return JSON.stringify(res);
  } catch {
    return String(res);
  }
}
