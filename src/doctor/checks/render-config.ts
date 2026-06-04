/**
 * render-config check — for isolated-mode memory dirs, walks each agent
 * directory and verifies the render.yaml is present and parseable.
 *
 * No-op in shared (non-isolated) mode, since there's no per-agent
 * render.yaml in that layout.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  isIsolated,
  listAgents,
  writeRenderConfig,
  DEFAULT_RENDER_CONFIG,
} from '../../isolation.js';
import type { Check, CheckResult, DoctorContext, FixOpts, FixOutcome } from '../types.js';

interface AgentRenderProbe {
  agent: string;
  agentDir: string;
  renderPath: string;
  status: 'ok' | 'missing' | 'invalid';
  invalidReason?: string;
}

function probe(memoryDir: string): AgentRenderProbe[] | null {
  if (!isIsolated(memoryDir)) return null;
  const out: AgentRenderProbe[] = [];
  for (const agent of listAgents(memoryDir)) {
    const agentDir = path.join(memoryDir, 'agents', agent);
    const renderPath = path.join(agentDir, 'render.yaml');
    const entry: AgentRenderProbe = { agent, agentDir, renderPath, status: 'ok' };
    if (!fs.existsSync(renderPath)) {
      entry.status = 'missing';
    } else {
      try {
        const parsed = yaml.load(fs.readFileSync(renderPath, 'utf-8')) as unknown;
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          entry.status = 'invalid';
          entry.invalidReason = `expected a YAML mapping, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`;
        }
      } catch (err) {
        entry.status = 'invalid';
        entry.invalidReason = (err as Error).message;
      }
    }
    out.push(entry);
  }
  return out;
}

export const renderConfigCheck: Check = {
  name: 'render-config',
  category: 'memory',
  defaultSeverity: 'warn',
  skipWhen: ['store'],
  run(ctx: DoctorContext): CheckResult {
    const probes = probe(ctx.memoryDir);
    if (probes === null) {
      return {
        name: renderConfigCheck.name,
        category: renderConfigCheck.category,
        severity: 'info',
        ok: true,
        issues: [],
        skipped: { reason: 'shared (non-isolated) memory — no per-agent render.yaml' },
      };
    }

    const issues: string[] = [];
    for (const p of probes) {
      if (p.status === 'missing') {
        issues.push(`${p.agent}: render.yaml missing at ${p.renderPath}`);
      } else if (p.status === 'invalid') {
        issues.push(`${p.agent}: render.yaml invalid — ${p.invalidReason}`);
      }
    }

    return {
      name: renderConfigCheck.name,
      category: renderConfigCheck.category,
      severity: 'warn',
      ok: issues.length === 0,
      issues,
    };
  },
  fix(ctx: DoctorContext, _result: CheckResult, opts: FixOpts): FixOutcome {
    const probes = probe(ctx.memoryDir);
    if (probes === null) return { applied: [], remaining: [] };

    const applied: string[] = [];
    const remaining: string[] = [];
    const errors: string[] = [];

    for (const p of probes) {
      if (p.status === 'ok') continue;
      if (p.status === 'invalid') {
        // Refuse to overwrite user content.
        remaining.push(
          `${p.agent}: render.yaml invalid (refusing to overwrite) — ${p.invalidReason}`,
        );
        continue;
      }
      // status === 'missing'
      if (opts.dryRun) {
        applied.push(`would write default render.yaml for ${p.agent} at ${p.renderPath}`);
        continue;
      }
      try {
        writeRenderConfig(p.agentDir, { ...DEFAULT_RENDER_CONFIG });
        applied.push(`wrote default render.yaml for ${p.agent} at ${p.renderPath}`);
      } catch (err) {
        errors.push(`failed to write render.yaml for ${p.agent}: ${String(err)}`);
        remaining.push(`${p.agent}: render.yaml missing at ${p.renderPath}`);
      }
    }

    return errors.length > 0 ? { applied, remaining, errors } : { applied, remaining };
  },
};
