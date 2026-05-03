# Obsidian mk-graph — Phase 2 (plugin scaffold + static graph) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first usable Obsidian view of a memory-kernel store: a `packages/obsidian-mk-graph/` plugin package that reads atom `.md` files from a memory dir, renders them as a force-directed graph with the F2 baseline encoding (color=type, size=log-citations, border=classification, opacity=status; edge color=type, width=weight, dash=source, opacity=confidence), and supports hover-tooltip + click-to-open-file. Released as `obsidian-mk-graph@0.1.0` (BRAT-tier alpha).

**Architecture:** Plugin lives at `packages/obsidian-mk-graph/` as a sibling to `packages/openclaw-memory-kernel/` (no npm workspaces; manual `npm install` inside the package). Built by **esbuild** (Obsidian community convention) into a single bundled `main.js` at the package root. **No mk-core changes** — the plugin re-implements a minimal local atom parser (~50 LOC subset of `src/format.ts:parseAtom`) so it never imports the `memory-kernel` runtime (which would drag in `better-sqlite3` and break the Electron renderer). Visual constants (type colors etc.) are duplicated locally; a follow-up before Phase 5 distribution will refactor mk-core to expose a runtime-free `memory-kernel/parse` entrypoint that the plugin can depend on. Phase 2 reads only `ENTITIES/*.md` and `EPISODES/*.md` files (no `events.ndjson` — that's Phase 3 ReplayEngine). The renderer wraps [`vasturiano/force-graph`](https://github.com/vasturiano/force-graph) (Canvas 2D); WebGL/3D are deferred to v1.1 per spec §B. Force-directed is the only layout in Phase 2; timeline + radial-wander are Phases 3 / 4.

**Tech Stack:** TypeScript 5.x, esbuild, Obsidian Plugin API (1.4+), `force-graph` ^1.43.0, `js-yaml` ^4.1.1 (frontmatter parse), `gray-matter` ^4.0.3 (frontmatter split), vitest ^4.0.18 (pure-logic tests), Canvas 2D rendering.

**Spec:** [docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md](../specs/2026-04-28-obsidian-mk-graph-design.md) §3, §5.1, §5.2, §5.3 (force-only), §6 (phase row 2)

**Predecessor plan:** [docs/superpowers/plans/2026-04-29-obsidian-mk-graph-phase1-mk-core.md](2026-04-29-obsidian-mk-graph-phase1-mk-core.md) — already shipped as v1.17.0 / v1.17.1.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/obsidian-mk-graph/manifest.json` | Create | Obsidian plugin manifest (`id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly`) |
| `packages/obsidian-mk-graph/package.json` | Create | Package metadata, scripts (`build`, `dev`, `test`, `lint`), runtime + dev deps |
| `packages/obsidian-mk-graph/tsconfig.json` | Create | TypeScript compiler config (target ES2018, module ESNext, strict, jsx none) |
| `packages/obsidian-mk-graph/esbuild.config.mjs` | Create | Bundle `src/main.ts` → `main.js`; production + watch modes; `obsidian` external |
| `packages/obsidian-mk-graph/.gitignore` | Create | Ignore `node_modules/`, `main.js`, `*.log` |
| `packages/obsidian-mk-graph/.npmrc` | Create | `engine-strict=true` to prevent accidental Node mismatch |
| `packages/obsidian-mk-graph/styles.css` | Create | Plugin styles for tooltip, settings sections, view container |
| `packages/obsidian-mk-graph/README.md` | Create | Install via BRAT, build-from-source, settings overview, screenshots placeholder |
| `packages/obsidian-mk-graph/CHANGELOG.md` | Create | Plugin-local changelog (independent of mk-core version) |
| `packages/obsidian-mk-graph/LICENSE` | Create | Apache-2.0 (matches mk-core) |
| `packages/obsidian-mk-graph/src/main.ts` | Create | Plugin class (`MkGraphPlugin extends Plugin`); `onload`/`onunload`; registers view, command, settings tab |
| `packages/obsidian-mk-graph/src/view.ts` | Create | `MkGraphView extends ItemView`; mounts renderer, wires DataLoader + watcher |
| `packages/obsidian-mk-graph/src/settings.ts` | Create | `MkGraphSettings` interface, `DEFAULT_SETTINGS`, `MkGraphSettingTab extends PluginSettingTab` |
| `packages/obsidian-mk-graph/src/atom-parser.ts` | Create | `parseAtomFile(content, path?) → ParsedAtom` — minimal local parser, no mk-core dep |
| `packages/obsidian-mk-graph/src/data-loader.ts` | Create | `readVault(memoryDir, agentId?) → Promise<{atoms, relations}>`; `watchVault(memoryDir, onChange)` |
| `packages/obsidian-mk-graph/src/graph-state.ts` | Create | `GraphState` class — observable map of atoms + relations; `subscribe(fn)`; `replace(loaded)` |
| `packages/obsidian-mk-graph/src/encoding.ts` | Create | F2 pure functions: `nodeColor`, `nodeSize`, `nodeBorderColor`, `nodeOpacity`, `edgeColor`, `edgeWidth`, `edgeDash`, `edgeOpacity` |
| `packages/obsidian-mk-graph/src/visual.ts` | Create | Visual constants — `TYPE_COLORS`, `RELATION_COLORS`, `CLASSIFICATION_BORDERS`, `STATUS_OPACITY`, `SOURCE_DASH` |
| `packages/obsidian-mk-graph/src/renderer.ts` | Create | `createRenderer(container, state, settings) → RendererHandle` — wraps `force-graph`, applies F2 encoding |
| `packages/obsidian-mk-graph/src/tooltip.ts` | Create | DOM tooltip element + `showTooltip(node, x, y)`/`hideTooltip()` |
| `packages/obsidian-mk-graph/src/citations.ts` | Create | `countIncomingCitations(state) → Map<id, number>` — for node size encoding |
| `packages/obsidian-mk-graph/test/atom-parser.test.ts` | Create | vitest — parse legacy + extended frontmatter, missing fields, malformed YAML |
| `packages/obsidian-mk-graph/test/data-loader.test.ts` | Create | vitest — tmp dir with ENTITIES/EPISODES, returns correct atoms; ignores hidden + non-md files |
| `packages/obsidian-mk-graph/test/graph-state.test.ts` | Create | vitest — replace + subscribe semantics |
| `packages/obsidian-mk-graph/test/encoding.test.ts` | Create | vitest — F2 mappings produce expected values for each combination |
| `packages/obsidian-mk-graph/test/citations.test.ts` | Create | vitest — citation count from a small relation set |
| `packages/obsidian-mk-graph/test/fixtures/small-vault/ENTITIES/*.md` | Create | ~20 hand-crafted atoms covering every type, status, classification |
| `packages/obsidian-mk-graph/test/fixtures/small-vault/EPISODES/*.md` | Create | 2–3 episode files for episode-aware paths |
| `packages/obsidian-mk-graph/test/fixtures/README.md` | Create | Documents what the fixture covers |
| `packages/obsidian-mk-graph/vitest.config.ts` | Create | vitest config — `node` environment, `test/**/*.test.ts` glob |

**Out of scope for this phase:**
- `events.ndjson` ingestion / ReplayEngine / scrubber UX → Phase 3
- Timeline + radial-wander layouts → Phases 3 / 4
- Wander viz layers (heatmap, ripple, constellation) + `MkCliRunner` subprocess → Phase 4
- F3 togglable layers (tag halos, evidence badge, TTL pulse, agent stripe) → Phase 5
- Performance hardening to 10k atoms, BRAT release infra, Community Plugins submission → Phase 5
- mk-core refactor to expose `memory-kernel/parse` runtime-free entrypoint → tracked follow-up before Phase 5
- Playwright-electron renderer tests → Phase 5 (Phase 2 uses vitest pure-logic + manual smoke checklist)
- Mobile parity, 3D toggle → spec §9 (deferred to v1.1)

---

## Task 1: Bootstrap plugin package (manifest, build, deps)

**Files:**
- Create: `packages/obsidian-mk-graph/manifest.json`
- Create: `packages/obsidian-mk-graph/package.json`
- Create: `packages/obsidian-mk-graph/tsconfig.json`
- Create: `packages/obsidian-mk-graph/esbuild.config.mjs`
- Create: `packages/obsidian-mk-graph/.gitignore`
- Create: `packages/obsidian-mk-graph/.npmrc`
- Create: `packages/obsidian-mk-graph/styles.css`
- Create: `packages/obsidian-mk-graph/LICENSE`
- Create: `packages/obsidian-mk-graph/src/main.ts` (stub)
- Create: `packages/obsidian-mk-graph/vitest.config.ts`

- [ ] **Step 1.1: Create the plugin directory**

```bash
mkdir -p packages/obsidian-mk-graph/src packages/obsidian-mk-graph/test/fixtures/small-vault/ENTITIES packages/obsidian-mk-graph/test/fixtures/small-vault/EPISODES
```

- [ ] **Step 1.2: Write `packages/obsidian-mk-graph/manifest.json`**

```json
{
  "id": "obsidian-mk-graph",
  "name": "Memory Kernel Graph",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Typed event-sourced graph view for memory-kernel atoms — colors by type, borders by classification, opacity by status. Read-only.",
  "author": "mainion-ai",
  "authorUrl": "https://github.com/mainion-ai/memory-kernel",
  "fundingUrl": "",
  "isDesktopOnly": true
}
```

- [ ] **Step 1.3: Write `packages/obsidian-mk-graph/package.json`**

```json
{
  "name": "obsidian-mk-graph",
  "version": "0.1.0",
  "description": "Obsidian plugin: typed graph view for memory-kernel",
  "main": "main.js",
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "keywords": ["obsidian", "obsidian-plugin", "memory-kernel", "graph", "knowledge-graph"],
  "author": "mainion-ai",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+ssh://git@github.com/mainion-ai/memory-kernel.git",
    "directory": "packages/obsidian-mk-graph"
  },
  "dependencies": {
    "force-graph": "^1.43.0",
    "gray-matter": "^4.0.3",
    "js-yaml": "^4.1.1"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^25.6.0",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.24.0",
    "obsidian": "^1.4.11",
    "tslib": "^2.6.2",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  }
}
```

- [ ] **Step 1.4: Write `packages/obsidian-mk-graph/tsconfig.json`**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "lib": ["DOM", "ES2018"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 1.5: Write `packages/obsidian-mk-graph/esbuild.config.mjs`**

```javascript
import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
```

- [ ] **Step 1.6: Write `packages/obsidian-mk-graph/.gitignore`**

```
node_modules/
main.js
*.log
.DS_Store
data.json
```

- [ ] **Step 1.7: Write `packages/obsidian-mk-graph/.npmrc`**

```
engine-strict=true
```

- [ ] **Step 1.8: Write `packages/obsidian-mk-graph/styles.css` (placeholder)**

```css
/* obsidian-mk-graph — see src/tooltip.ts and src/view.ts for what gets styled here */

.mk-graph-view-container {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--background-primary);
}

.mk-graph-tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--background-secondary);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  max-width: 320px;
  z-index: 10;
  display: none;
}

.mk-graph-tooltip.is-visible {
  display: block;
}

.mk-graph-tooltip-id {
  font-family: var(--font-monospace);
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.mk-graph-tooltip-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.mk-graph-tooltip-meta {
  color: var(--text-muted);
  font-size: 11px;
}
```

- [ ] **Step 1.9: Copy the Apache-2.0 license to `packages/obsidian-mk-graph/LICENSE`**

```bash
cp LICENSE packages/obsidian-mk-graph/LICENSE
```

(The repo root `LICENSE` is Apache-2.0; this satisfies §G's distribution requirement and makes the plugin package self-contained for BRAT.)

- [ ] **Step 1.10: Write `packages/obsidian-mk-graph/src/main.ts` (stub — fleshed out in Task 11)**

```typescript
import { Plugin } from 'obsidian';

export default class MkGraphPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log('mk-graph: onload (Phase 2 stub)');
  }

  async onunload(): Promise<void> {
    console.log('mk-graph: onunload');
  }
}
```

- [ ] **Step 1.11: Write `packages/obsidian-mk-graph/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
```

- [ ] **Step 1.12: Install deps and verify the build**

```bash
cd packages/obsidian-mk-graph
npm install
npm run build
ls -la main.js
```

Expected: `main.js` exists at the package root, ~5–20KB (Obsidian Plugin API is `external`, so the stub is tiny).

- [ ] **Step 1.13: Verify `npm run lint` passes**

```bash
cd packages/obsidian-mk-graph && npm run lint
```

Expected: no output, exit 0.

- [ ] **Step 1.14: Verify vitest runs (no tests yet, but harness must work)**

```bash
cd packages/obsidian-mk-graph && npm test -- --passWithNoTests
```

Expected: `No test files found ... Pass with no tests`.

- [ ] **Step 1.15: Commit**

```bash
git add packages/obsidian-mk-graph
git commit -m "feat(obsidian-mk-graph): bootstrap plugin package scaffold

Adds packages/obsidian-mk-graph/ with manifest, esbuild build, vitest
harness, Apache-2.0 license, and a stub Plugin class that loads cleanly.
No mk-core dependencies — bundled main.js stays free of native modules.
First scaffolding task in Phase 2 of the spec."
```

---

## Task 2: Local atom parser (`atom-parser.ts`)

The plugin can't import `parseAtom` from `memory-kernel` without dragging in `better-sqlite3`. We re-implement a minimal, runtime-free subset that handles the frontmatter shape we care about for visualization (id, type, status, classification, created_at, updated_at, ttl_days, scope.tags, relations[]). It deliberately does **not** validate — for visualization, garbage atoms degrade gracefully (default values in the encoding step) rather than block rendering.

**Files:**
- Create: `packages/obsidian-mk-graph/src/atom-parser.ts`
- Create: `packages/obsidian-mk-graph/test/atom-parser.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/atom-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseAtomFile } from '../src/atom-parser.js';

describe('parseAtomFile', () => {
  it('parses a fully-populated atom with extended relations', () => {
    const md = `---
id: FACT-2026-04-29-EXAMPLE-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
classification: TEAM
scope:
  tags: [demo, sample]
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: extends
    confidence: 0.85
    weight: 1.6
    source: manual
---

Body content here.
`;
    const atom = parseAtomFile(md, '/vault/.mk/ENTITIES/FACT-2026-04-29-EXAMPLE-aa00.md');
    expect(atom).not.toBeNull();
    expect(atom!.id).toBe('FACT-2026-04-29-EXAMPLE-aa00');
    expect(atom!.type).toBe('fact');
    expect(atom!.status).toBe('active');
    expect(atom!.classification).toBe('TEAM');
    expect(atom!.tags).toEqual(['demo', 'sample']);
    expect(atom!.createdAt).toBe('2026-04-29T10:00:00Z');
    expect(atom!.relations).toHaveLength(1);
    expect(atom!.relations[0]).toEqual({
      target: 'FACT-2026-04-28-OTHER-bb01',
      type: 'extends',
      confidence: 0.85,
      weight: 1.6,
      source: 'manual',
    });
    expect(atom!.body).toContain('Body content here.');
    expect(atom!.filePath).toBe('/vault/.mk/ENTITIES/FACT-2026-04-29-EXAMPLE-aa00.md');
  });

  it('parses a legacy {target,type}-only relation', () => {
    const md = `---
id: FACT-2026-04-29-LEGACY-aa00
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
relations:
  - target: FACT-2026-04-28-OTHER-bb01
    type: supports
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.relations[0]).toEqual({
      target: 'FACT-2026-04-28-OTHER-bb01',
      type: 'supports',
    });
  });

  it('defaults missing optional fields gracefully', () => {
    const md = `---
id: BELI-2026-04-29-MIN-aa00
type: belief
status: active
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
---

Body.
`;
    const atom = parseAtomFile(md);
    expect(atom!.classification).toBe('TEAM'); // F2 default per spec §5.2
    expect(atom!.tags).toEqual([]);
    expect(atom!.relations).toEqual([]);
  });

  it('returns null for missing required fields (id/type/status) instead of throwing', () => {
    const md = `---
type: fact
status: active
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('returns null for malformed YAML instead of throwing', () => {
    const md = `---
id: [this: is: not: valid
---
Body.
`;
    expect(parseAtomFile(md)).toBeNull();
  });

  it('strips the `## Relations` body section if present', () => {
    const md = `---
id: FACT-2026-04-29-RELS-aa00
type: fact
status: active
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
---

Real body content.

## Relations

- [[FACT-2026-04-28-OTHER-bb01]] (extends)
`;
    const atom = parseAtomFile(md);
    expect(atom!.body.trim()).toBe('Real body content.');
  });
});
```

- [ ] **Step 2.2: Run the test, verify it fails**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: FAIL — `parseAtomFile` not exported.

- [ ] **Step 2.3: Implement `src/atom-parser.ts`**

```typescript
import matter from 'gray-matter';

/** Atom shape used by the plugin — flatter than mk-core's AtomFrontmatter for renderer ergonomics. */
export interface ParsedAtom {
  id: string;
  type: string;             // atom type — never validated; encoding falls back to grey on unknown
  status: string;           // atom status — same, falls back to opacity 1.0
  classification: string;   // PUBLIC | TEAM | PERSONAL | SECRET; defaults to TEAM (F2 spec §5.2)
  confidence: number;       // 0..1; default 1.0
  createdAt: string;        // ISO8601
  updatedAt: string;        // ISO8601
  ttlDays: number | null;   // null = no expiry
  tags: string[];           // flattened from scope.tags
  relations: ParsedRelation[];
  body: string;             // body with the `## Relations` section stripped
  filePath?: string;
}

export interface ParsedRelation {
  target: string;
  type: string;             // never validated; renderer falls back to grey
  createdAt?: string;
  confidence?: number;
  weight?: number;
  source?: string;          // manual | extracted | enriched | unknown — falls back to 'unknown'
  evidence?: string[];
}

const RELATIONS_SECTION_RE = /\n##\s+Relations\s*\n[\s\S]*$/m;

/**
 * Parse a memory-kernel atom markdown file into a renderer-friendly shape.
 * Returns null if the file is malformed or missing required fields — the
 * loader silently skips nulls so a single bad file doesn't break the graph.
 */
export function parseAtomFile(content: string, filePath?: string): ParsedAtom | null {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  const fm = parsed.data as Record<string, unknown>;
  if (typeof fm.id !== 'string' || !fm.id) return null;
  if (typeof fm.type !== 'string' || !fm.type) return null;
  if (typeof fm.status !== 'string' || !fm.status) return null;

  const scope = (fm.scope ?? {}) as { tags?: unknown };
  const rawTags = Array.isArray(scope.tags) ? scope.tags : [];
  const tags = rawTags.filter((t): t is string => typeof t === 'string');

  const rawRelations = Array.isArray(fm.relations) ? fm.relations : [];
  const relations: ParsedRelation[] = [];
  for (const r of rawRelations) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.target !== 'string' || typeof rec.type !== 'string') continue;
    const rel: ParsedRelation = { target: rec.target, type: rec.type };
    if (typeof rec.created_at === 'string') rel.createdAt = rec.created_at;
    if (typeof rec.confidence === 'number') rel.confidence = rec.confidence;
    if (typeof rec.weight === 'number') rel.weight = rec.weight;
    if (typeof rec.source === 'string') rel.source = rec.source;
    if (Array.isArray(rec.evidence)) {
      rel.evidence = rec.evidence.filter((e): e is string => typeof e === 'string');
    }
    relations.push(rel);
  }

  const body = parsed.content.replace(RELATIONS_SECTION_RE, '').trim();

  return {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    classification: typeof fm.classification === 'string' ? fm.classification : 'TEAM',
    confidence: typeof fm.confidence === 'number' ? fm.confidence : 1.0,
    createdAt: typeof fm.created_at === 'string' ? fm.created_at : '',
    updatedAt: typeof fm.updated_at === 'string' ? fm.updated_at : '',
    ttlDays:
      fm.ttl_days === null
        ? null
        : typeof fm.ttl_days === 'number'
        ? fm.ttl_days
        : null,
    tags,
    relations,
    body,
    filePath,
  };
}
```

- [ ] **Step 2.4: Run the tests, verify they pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: 6 tests pass.

- [ ] **Step 2.5: Verify the bundle still builds**

```bash
cd packages/obsidian-mk-graph && npm run build && npm run lint
```

Expected: `main.js` rebuilt cleanly; no type errors.

- [ ] **Step 2.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/atom-parser.ts packages/obsidian-mk-graph/test/atom-parser.test.ts
git commit -m "feat(obsidian-mk-graph): add local atom parser with TDD coverage

Minimal subset of mk-core's parseAtom — handles frontmatter+body, legacy
and extended relations, falls back to safe defaults on missing optional
fields, and returns null (not throws) on malformed YAML or missing
required fields. Pure-JS, no mk-core runtime import."
```

---

## Task 3: Visual constants (`visual.ts`)

A pure-data module with the F2 encoding constants. Lives separately from `encoding.ts` so future phases can swap palettes (e.g., a colorblind-friendly mode in Phase 5) without touching the encoding logic.

**Files:**
- Create: `packages/obsidian-mk-graph/src/visual.ts`

- [ ] **Step 3.1: Implement `src/visual.ts`**

```typescript
/**
 * Visual constants for the F2 baseline encoding (spec §5.2).
 * All values are duplicated from mk-core deliberately — the plugin must
 * not import the memory-kernel runtime (native deps break the renderer).
 * Keep in sync with src/cli/export-obsidian.ts:TYPE_COLORS and the spec.
 */

/** Hex strings (CSS-friendly) for atom-type node fills. Derived from
 *  src/cli/export-obsidian.ts TYPE_COLORS (RGB ints reformatted as #RRGGBB). */
export const TYPE_COLORS: Record<string, string> = {
  belief:         '#4A90D9',
  fact:           '#27AE60',
  decision:       '#E67E22',
  open_question:  '#9B59B6',
  preference:     '#E91E63',
  constraint:     '#E74C3C',
  procedure:      '#1ABC9C',
  entity_summary: '#F1C40F',
  conflict:       '#FF5722',
};

/** Fallback fill for atoms with an unknown type. */
export const TYPE_COLOR_FALLBACK = '#95A5A6';

/** Edge palette — distinct from node palette per spec §5.2. */
export const RELATION_COLORS: Record<string, string> = {
  extends:    '#3498DB', // blue
  contradicts:'#C0392B', // dark red
  supports:   '#2ECC71', // green
  caused_by:  '#8E44AD', // purple
  supersedes: '#D35400', // dark orange
  applied_to: '#16A085', // dark teal
  related:    '#7F8C8D', // grey
};

export const RELATION_COLOR_FALLBACK = '#7F8C8D';

/** Border colors per classification (F2 spec §5.2). */
export const CLASSIFICATION_BORDERS: Record<string, string> = {
  PUBLIC:   '#27AE60', // green
  TEAM:     '#3498DB', // blue (default)
  PERSONAL: '#F39C12', // orange
  SECRET:   '#C0392B', // red
};

export const CLASSIFICATION_BORDER_FALLBACK = '#3498DB';

/** Status → opacity (F2 spec §5.2). 'expired' is hidden via 0; the
 *  renderer should filter expired atoms before passing to force-graph. */
export const STATUS_OPACITY: Record<string, number> = {
  draft:      0.5,
  active:     1.0,
  accepted:   1.0,
  rejected:   0.4,
  superseded: 0.3,
  resolved:   0.7,
  archived:   0.2,
  expired:    0.0,
};

export const STATUS_OPACITY_FALLBACK = 1.0;

/** Edge-source dash patterns (F2 spec §5.2). [] = solid. */
export const SOURCE_DASH: Record<string, number[]> = {
  manual:    [],
  extracted: [5, 3],
  enriched:  [2, 3],
  unknown:   [],
};

export const SOURCE_DASH_FALLBACK: number[] = [];

/** SECRET classification gets a 🔒 glyph badge per spec §5.2. */
export const SECRET_GLYPH = '🔒';

/** Default per-relation-type weight when relation.weight is undefined.
 *  Mirrors mk-core DEFAULT_TYPE_WEIGHTS (constitution preset shape). */
export const DEFAULT_RELATION_WEIGHT: Record<string, number> = {
  extends:    1.0,
  contradicts:1.5,
  supports:   1.0,
  caused_by:  1.2,
  supersedes: 1.3,
  applied_to: 0.8,
  related:    0.6,
};

export const DEFAULT_RELATION_WEIGHT_FALLBACK = 1.0;
```

- [ ] **Step 3.2: Verify lint passes**

```bash
cd packages/obsidian-mk-graph && npm run lint
```

Expected: clean.

- [ ] **Step 3.3: Commit**

```bash
git add packages/obsidian-mk-graph/src/visual.ts
git commit -m "feat(obsidian-mk-graph): add visual constants for F2 encoding

Duplicates mk-core's TYPE_COLORS into hex form, plus relation palette,
classification borders, status opacity, and source dash patterns. Kept
separate from encoding.ts so palette swaps stay isolated."
```

---

## Task 4: Citation counter (`citations.ts`)

Node size in F2 is `4 + 6 * log10(citation_count + 1)` pixels, where citation count = inbound edges. Pure function over a relation list. Tested separately so encoding stays free of aggregation logic.

**Files:**
- Create: `packages/obsidian-mk-graph/src/citations.ts`
- Create: `packages/obsidian-mk-graph/test/citations.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `packages/obsidian-mk-graph/test/citations.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { countIncomingCitations } from '../src/citations.js';
import type { ParsedAtom } from '../src/atom-parser.js';

function atom(id: string, relTargets: string[]): ParsedAtom {
  return {
    id,
    type: 'fact',
    status: 'active',
    classification: 'TEAM',
    confidence: 1.0,
    createdAt: '2026-04-29T10:00:00Z',
    updatedAt: '2026-04-29T10:00:00Z',
    ttlDays: null,
    tags: [],
    relations: relTargets.map((target) => ({ target, type: 'related' })),
    body: '',
  };
}

describe('countIncomingCitations', () => {
  it('counts inbound edges per atom id', () => {
    const atoms: ParsedAtom[] = [
      atom('A', ['B', 'C']),
      atom('B', ['C']),
      atom('C', []),
    ];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('A')).toBeUndefined();
    expect(counts.get('B')).toBe(1);
    expect(counts.get('C')).toBe(2);
  });

  it('returns 0 (undefined) for atoms with no inbound edges', () => {
    const atoms: ParsedAtom[] = [atom('A', []), atom('B', [])];
    const counts = countIncomingCitations(atoms);
    expect(counts.size).toBe(0);
  });

  it('ignores edges that point to non-existent atoms', () => {
    const atoms: ParsedAtom[] = [atom('A', ['MISSING'])];
    const counts = countIncomingCitations(atoms);
    expect(counts.get('MISSING')).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
cd packages/obsidian-mk-graph && npm test test/citations.test.ts
```

Expected: FAIL — `countIncomingCitations` undefined.

- [ ] **Step 4.3: Implement `src/citations.ts`**

```typescript
import type { ParsedAtom } from './atom-parser.js';

/**
 * Count inbound relation edges per atom id, restricted to edges whose
 * target exists in the input set. Used by the F2 encoder to size nodes
 * by `log10(citations+1)`. Edges to missing atoms are ignored so dangling
 * references don't inflate phantom node sizes.
 */
export function countIncomingCitations(atoms: ParsedAtom[]): Map<string, number> {
  const known = new Set(atoms.map((a) => a.id));
  const counts = new Map<string, number>();
  for (const a of atoms) {
    for (const rel of a.relations) {
      if (!known.has(rel.target)) continue;
      counts.set(rel.target, (counts.get(rel.target) ?? 0) + 1);
    }
  }
  return counts;
}
```

- [ ] **Step 4.4: Run tests, verify pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all tests pass (parser + citations).

- [ ] **Step 4.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/citations.ts packages/obsidian-mk-graph/test/citations.test.ts
git commit -m "feat(obsidian-mk-graph): add citation counter for F2 node sizing"
```

---

## Task 5: F2 encoding (`encoding.ts`)

Pure functions mapping `(atom | relation) → visual property`. The renderer wires these into `force-graph` callbacks; keeping them pure makes them unit-testable and lets future phases (Phase 4 wander dimming) compose new encoders on top without forking renderer code.

**Files:**
- Create: `packages/obsidian-mk-graph/src/encoding.ts`
- Create: `packages/obsidian-mk-graph/test/encoding.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/encoding.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  nodeColor,
  nodeSize,
  nodeBorderColor,
  nodeOpacity,
  edgeColor,
  edgeWidth,
  edgeDash,
  edgeOpacity,
} from '../src/encoding.js';
import type { ParsedAtom, ParsedRelation } from '../src/atom-parser.js';

function makeAtom(overrides: Partial<ParsedAtom> = {}): ParsedAtom {
  return {
    id: 'FACT-2026-04-29-X-aa00',
    type: 'fact',
    status: 'active',
    classification: 'TEAM',
    confidence: 1.0,
    createdAt: '2026-04-29T10:00:00Z',
    updatedAt: '2026-04-29T10:00:00Z',
    ttlDays: null,
    tags: [],
    relations: [],
    body: '',
    ...overrides,
  };
}

describe('node encoding', () => {
  it('nodeColor returns the type palette hex, falls back on unknown', () => {
    expect(nodeColor(makeAtom({ type: 'fact' }))).toBe('#27AE60');
    expect(nodeColor(makeAtom({ type: 'belief' }))).toBe('#4A90D9');
    expect(nodeColor(makeAtom({ type: 'unknown_type' }))).toBe('#95A5A6');
  });

  it('nodeSize floors at 4px and grows logarithmically', () => {
    expect(nodeSize(0)).toBeCloseTo(4, 5); // log10(1) = 0 -> 4
    expect(nodeSize(9)).toBeCloseTo(10, 5); // log10(10) = 1 -> 4 + 6
    expect(nodeSize(99)).toBeCloseTo(16, 5); // log10(100) = 2 -> 4 + 12
  });

  it('nodeBorderColor returns classification color, defaults to TEAM blue', () => {
    expect(nodeBorderColor(makeAtom({ classification: 'PUBLIC' }))).toBe('#27AE60');
    expect(nodeBorderColor(makeAtom({ classification: 'SECRET' }))).toBe('#C0392B');
    expect(nodeBorderColor(makeAtom({ classification: 'WEIRD' }))).toBe('#3498DB');
  });

  it('nodeOpacity applies status mapping; expired returns 0', () => {
    expect(nodeOpacity(makeAtom({ status: 'active' }))).toBe(1.0);
    expect(nodeOpacity(makeAtom({ status: 'rejected' }))).toBe(0.4);
    expect(nodeOpacity(makeAtom({ status: 'expired' }))).toBe(0.0);
    expect(nodeOpacity(makeAtom({ status: 'unknown_status' }))).toBe(1.0);
  });
});

describe('edge encoding', () => {
  function makeRel(overrides: Partial<ParsedRelation> = {}): ParsedRelation {
    return { target: 'FACT-x', type: 'related', ...overrides };
  }

  it('edgeColor returns relation-type palette, falls back grey', () => {
    expect(edgeColor(makeRel({ type: 'supports' }))).toBe('#2ECC71');
    expect(edgeColor(makeRel({ type: 'contradicts' }))).toBe('#C0392B');
    expect(edgeColor(makeRel({ type: 'unknown_rel' }))).toBe('#7F8C8D');
  });

  it('edgeWidth uses relation.weight when set, else type default, clamped [0.5, 8]', () => {
    expect(edgeWidth(makeRel({ type: 'related', weight: 1.0 }))).toBeCloseTo(3.0, 5);
    expect(edgeWidth(makeRel({ type: 'contradicts' }))).toBeCloseTo(4.0, 5); // default 1.5
    expect(edgeWidth(makeRel({ type: 'related', weight: 0 }))).toBe(1.0); // 1 + 0 = 1
    expect(edgeWidth(makeRel({ type: 'related', weight: 100 }))).toBe(8); // clamp
    expect(edgeWidth(makeRel({ type: 'related', weight: -10 }))).toBe(0.5); // clamp
  });

  it('edgeDash returns the source pattern, falls back solid', () => {
    expect(edgeDash(makeRel({ source: 'manual' }))).toEqual([]);
    expect(edgeDash(makeRel({ source: 'extracted' }))).toEqual([5, 3]);
    expect(edgeDash(makeRel({ source: 'enriched' }))).toEqual([2, 3]);
    expect(edgeDash(makeRel())).toEqual([]); // undefined -> solid
  });

  it('edgeOpacity floors at 0.3, scales by confidence', () => {
    expect(edgeOpacity(makeRel({ confidence: 1.0 }))).toBeCloseTo(1.0, 5);
    expect(edgeOpacity(makeRel({ confidence: 0.5 }))).toBeCloseTo(0.65, 5);
    expect(edgeOpacity(makeRel({ confidence: 0 }))).toBeCloseTo(0.3, 5);
    expect(edgeOpacity(makeRel())).toBeCloseTo(1.0, 5); // undefined -> 1.0
  });
});
```

- [ ] **Step 5.2: Run, verify failure**

```bash
cd packages/obsidian-mk-graph && npm test test/encoding.test.ts
```

Expected: FAIL — none of the encoding functions exist yet.

- [ ] **Step 5.3: Implement `src/encoding.ts`**

```typescript
import type { ParsedAtom, ParsedRelation } from './atom-parser.js';
import {
  TYPE_COLORS, TYPE_COLOR_FALLBACK,
  RELATION_COLORS, RELATION_COLOR_FALLBACK,
  CLASSIFICATION_BORDERS, CLASSIFICATION_BORDER_FALLBACK,
  STATUS_OPACITY, STATUS_OPACITY_FALLBACK,
  SOURCE_DASH, SOURCE_DASH_FALLBACK,
  DEFAULT_RELATION_WEIGHT, DEFAULT_RELATION_WEIGHT_FALLBACK,
} from './visual.js';

/** F2 node fill: color = atom type. */
export function nodeColor(atom: ParsedAtom): string {
  return TYPE_COLORS[atom.type] ?? TYPE_COLOR_FALLBACK;
}

/** F2 node radius (px): 4 + 6 * log10(citations + 1). */
export function nodeSize(citationCount: number): number {
  const safe = Math.max(0, citationCount);
  return 4 + 6 * Math.log10(safe + 1);
}

/** F2 node border: classification (PUBLIC/TEAM/PERSONAL/SECRET). */
export function nodeBorderColor(atom: ParsedAtom): string {
  return CLASSIFICATION_BORDERS[atom.classification] ?? CLASSIFICATION_BORDER_FALLBACK;
}

/** F2 node opacity by status. Expired → 0 (renderer should hide instead of draw). */
export function nodeOpacity(atom: ParsedAtom): number {
  return STATUS_OPACITY[atom.status] ?? STATUS_OPACITY_FALLBACK;
}

/** F2 edge color: relation type. */
export function edgeColor(rel: ParsedRelation): string {
  return RELATION_COLORS[rel.type] ?? RELATION_COLOR_FALLBACK;
}

/** F2 edge width: 1 + 2 * (rel.weight ?? type_default), clamped to [0.5, 8]. */
export function edgeWidth(rel: ParsedRelation): number {
  const weight = rel.weight ?? DEFAULT_RELATION_WEIGHT[rel.type] ?? DEFAULT_RELATION_WEIGHT_FALLBACK;
  const w = 1 + 2 * weight;
  return Math.max(0.5, Math.min(8, w));
}

/** F2 edge dash: source pattern. Manual = solid. */
export function edgeDash(rel: ParsedRelation): number[] {
  if (!rel.source) return SOURCE_DASH_FALLBACK;
  return SOURCE_DASH[rel.source] ?? SOURCE_DASH_FALLBACK;
}

/** F2 edge opacity: 0.3 + 0.7 * confidence (never below 0.3). */
export function edgeOpacity(rel: ParsedRelation): number {
  const c = rel.confidence ?? 1.0;
  const clamped = Math.max(0, Math.min(1, c));
  return 0.3 + 0.7 * clamped;
}
```

- [ ] **Step 5.4: Run tests, verify pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all 14+ tests pass (parser + citations + encoding).

- [ ] **Step 5.5: Verify lint + build**

```bash
cd packages/obsidian-mk-graph && npm run lint && npm run build
```

- [ ] **Step 5.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/encoding.ts packages/obsidian-mk-graph/test/encoding.test.ts
git commit -m "feat(obsidian-mk-graph): add F2 visual encoding pure functions

Maps atom/relation properties to color, size, border, opacity, width,
and dash per spec §5.2 baseline. All falls back to safe defaults so
renderer never crashes on unknown values."
```

---

## Task 6: GraphState observable (`graph-state.ts`)

A small observable wrapper around `Map<id, ParsedAtom>` plus an outbound-relation index. Lets the renderer subscribe to changes without re-implementing pub/sub or coupling to Obsidian-specific event APIs. Phase 3's ReplayEngine will call `replace(...)` to reset state at a new playhead — designed for that now.

**Files:**
- Create: `packages/obsidian-mk-graph/src/graph-state.ts`
- Create: `packages/obsidian-mk-graph/test/graph-state.test.ts`

- [ ] **Step 6.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/graph-state.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { GraphState } from '../src/graph-state.js';
import type { ParsedAtom } from '../src/atom-parser.js';

function atom(id: string, relTargets: string[] = []): ParsedAtom {
  return {
    id,
    type: 'fact',
    status: 'active',
    classification: 'TEAM',
    confidence: 1.0,
    createdAt: '2026-04-29T10:00:00Z',
    updatedAt: '2026-04-29T10:00:00Z',
    ttlDays: null,
    tags: [],
    relations: relTargets.map((t) => ({ target: t, type: 'related' })),
    body: '',
  };
}

describe('GraphState', () => {
  it('starts empty', () => {
    const s = new GraphState();
    expect(s.atoms.size).toBe(0);
    expect(s.outbound('A')).toEqual([]);
  });

  it('replace() loads atoms and indexes outbound relations', () => {
    const s = new GraphState();
    s.replace([atom('A', ['B']), atom('B', [])]);
    expect(s.atoms.size).toBe(2);
    expect(s.atoms.get('A')!.id).toBe('A');
    expect(s.outbound('A')).toHaveLength(1);
    expect(s.outbound('A')[0].target).toBe('B');
    expect(s.outbound('B')).toEqual([]);
  });

  it('replace() drops atoms not in the new set', () => {
    const s = new GraphState();
    s.replace([atom('A'), atom('B')]);
    s.replace([atom('B')]);
    expect(s.atoms.has('A')).toBe(false);
    expect(s.atoms.has('B')).toBe(true);
  });

  it('subscribe() fires on every replace()', () => {
    const s = new GraphState();
    const fn = vi.fn();
    s.subscribe(fn);
    s.replace([atom('A')]);
    s.replace([atom('B')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('subscribe() returns an unsubscribe handle', () => {
    const s = new GraphState();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.replace([atom('A')]);
    off();
    s.replace([atom('B')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('toGraphData() returns nodes + links arrays for force-graph', () => {
    const s = new GraphState();
    s.replace([atom('A', ['B']), atom('B')]);
    const data = s.toGraphData();
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(data.links).toHaveLength(1);
    expect(data.links[0].source).toBe('A');
    expect(data.links[0].target).toBe('B');
  });

  it('toGraphData() drops links to unknown targets', () => {
    const s = new GraphState();
    s.replace([atom('A', ['MISSING'])]);
    const data = s.toGraphData();
    expect(data.links).toHaveLength(0);
  });
});
```

- [ ] **Step 6.2: Run, verify failure**

```bash
cd packages/obsidian-mk-graph && npm test test/graph-state.test.ts
```

Expected: FAIL — `GraphState` undefined.

- [ ] **Step 6.3: Implement `src/graph-state.ts`**

```typescript
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
```

- [ ] **Step 6.4: Run tests, verify pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add packages/obsidian-mk-graph/src/graph-state.ts packages/obsidian-mk-graph/test/graph-state.test.ts
git commit -m "feat(obsidian-mk-graph): add observable GraphState with toGraphData()

Single source of truth for the renderer. replace() loads a fresh atom
set and notifies subscribers. toGraphData() emits a force-graph-shaped
{nodes, links} snapshot, dropping links to missing targets."
```

---

## Task 7: DataLoader (`data-loader.ts`)

Reads `<memoryDir>/ENTITIES/*.md` (and optionally `<memoryDir>/EPISODES/*.md` for episode-aware tooltips later) and returns a list of `ParsedAtom`s. Also exposes `watchVault()` using Node's `fs.watch` for Live mode — **not** Obsidian's `Vault.adapter` watcher because the memory dir may be outside the vault per setting `memoryDirOutsideVault`. Per-agent isolation is honoured: when `agentId` is set and `<memoryDir>/agents/<agentId>/` exists, read from there; falls back to the base dir for shared mode. Mirrors `resolveAgentDir` semantics from CLAUDE.md.

**Files:**
- Create: `packages/obsidian-mk-graph/src/data-loader.ts`
- Create: `packages/obsidian-mk-graph/test/data-loader.test.ts`

- [ ] **Step 7.1: Write the failing tests**

Create `packages/obsidian-mk-graph/test/data-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readVault, resolveMemoryDir } from '../src/data-loader.js';

const sampleAtom = (id: string) => `---
id: ${id}
type: fact
status: active
confidence: 0.9
created_at: "2026-04-29T10:00:00Z"
updated_at: "2026-04-29T10:00:00Z"
ttl_days: null
classification: TEAM
---

Body for ${id}.
`;

describe('readVault', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-test-'));
    mkdirSync(path.join(dir, 'ENTITIES'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads .md files from ENTITIES/ and returns ParsedAtoms', async () => {
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-A-aa00.md'),
      sampleAtom('FACT-2026-04-29-A-aa00'),
    );
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-B-bb00.md'),
      sampleAtom('FACT-2026-04-29-B-bb00'),
    );
    const atoms = await readVault(dir);
    expect(atoms).toHaveLength(2);
    expect(atoms.map((a) => a.id).sort()).toEqual([
      'FACT-2026-04-29-A-aa00',
      'FACT-2026-04-29-B-bb00',
    ]);
  });

  it('skips non-.md files and dotfiles', async () => {
    writeFileSync(path.join(dir, 'ENTITIES', '.hidden.md'), sampleAtom('X'));
    writeFileSync(path.join(dir, 'ENTITIES', 'README.txt'), 'not an atom');
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-OK-aa00.md'),
      sampleAtom('FACT-2026-04-29-OK-aa00'),
    );
    const atoms = await readVault(dir);
    expect(atoms.map((a) => a.id)).toEqual(['FACT-2026-04-29-OK-aa00']);
  });

  it('silently skips malformed atoms', async () => {
    writeFileSync(path.join(dir, 'ENTITIES', 'broken.md'), '---\n[invalid yaml\n---\nbody\n');
    writeFileSync(
      path.join(dir, 'ENTITIES', 'FACT-2026-04-29-OK-aa00.md'),
      sampleAtom('FACT-2026-04-29-OK-aa00'),
    );
    const atoms = await readVault(dir);
    expect(atoms.map((a) => a.id)).toEqual(['FACT-2026-04-29-OK-aa00']);
  });

  it('returns empty array if ENTITIES/ is missing', async () => {
    rmSync(path.join(dir, 'ENTITIES'), { recursive: true });
    const atoms = await readVault(dir);
    expect(atoms).toEqual([]);
  });
});

describe('resolveMemoryDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mk-graph-resolve-'));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns base dir in shared mode (no agentId)', () => {
    expect(resolveMemoryDir(dir)).toBe(dir);
    expect(resolveMemoryDir(dir, '')).toBe(dir);
  });

  it('returns agents/<id>/ when it exists', () => {
    const agentDir = path.join(dir, 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    expect(resolveMemoryDir(dir, 'alice')).toBe(agentDir);
  });

  it('falls back to base dir when agents/<id>/ does not exist', () => {
    expect(resolveMemoryDir(dir, 'missing')).toBe(dir);
  });
});
```

- [ ] **Step 7.2: Run, verify failure**

```bash
cd packages/obsidian-mk-graph && npm test test/data-loader.test.ts
```

Expected: FAIL — `readVault`, `resolveMemoryDir` not exported.

- [ ] **Step 7.3: Implement `src/data-loader.ts`**

```typescript
import { promises as fsp, existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseAtomFile, type ParsedAtom } from './atom-parser.js';

const ENTITIES_DIR = 'ENTITIES';
const EPISODES_DIR = 'EPISODES';
const AGENTS_DIR = 'agents';

/**
 * Resolve the effective memory dir for a given agent. Mirrors mk-core's
 * resolveAgentDir(): agents/<id>/ if it exists, else the base dir. Empty
 * agentId means shared mode. Plugin treats unknown agent IDs as a fallback
 * to base, never throws.
 */
export function resolveMemoryDir(baseDir: string, agentId?: string): string {
  if (!agentId) return baseDir;
  const agentDir = path.join(baseDir, AGENTS_DIR, agentId);
  return existsSync(agentDir) ? agentDir : baseDir;
}

/** Read all atom .md files from <memoryDir>/ENTITIES/. Skips dotfiles,
 *  non-.md files, and files that fail to parse. */
export async function readVault(memoryDir: string): Promise<ParsedAtom[]> {
  const entitiesDir = path.join(memoryDir, ENTITIES_DIR);
  if (!existsSync(entitiesDir)) return [];

  let names: string[];
  try {
    names = await fsp.readdir(entitiesDir);
  } catch {
    return [];
  }

  const atoms: ParsedAtom[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!name.endsWith('.md')) continue;
    const file = path.join(entitiesDir, name);
    let content: string;
    try {
      content = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const atom = parseAtomFile(content, file);
    if (atom) atoms.push(atom);
  }
  return atoms;
}

export interface Watcher {
  close(): void;
}

/**
 * Watch the memory dir for atom file mutations. Coalesces rapid changes
 * (~150ms) so a flurry of writes during seeding only triggers one reload.
 * Watches ENTITIES/ subdirectory non-recursively. Caller-provided `onChange`
 * is invoked on the trailing edge of the debounce window.
 */
export function watchVault(memoryDir: string, onChange: () => void): Watcher {
  const entitiesDir = path.join(memoryDir, ENTITIES_DIR);
  if (!existsSync(entitiesDir)) {
    return { close: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(entitiesDir, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, 150);
    });
  } catch {
    return { close: () => {} };
  }

  return {
    close(): void {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
    },
  };
}
```

- [ ] **Step 7.4: Run tests, verify pass**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all tests pass.

- [ ] **Step 7.5: Verify lint + build**

```bash
cd packages/obsidian-mk-graph && npm run lint && npm run build
```

- [ ] **Step 7.6: Commit**

```bash
git add packages/obsidian-mk-graph/src/data-loader.ts packages/obsidian-mk-graph/test/data-loader.test.ts
git commit -m "feat(obsidian-mk-graph): add DataLoader with per-agent resolution + watcher

readVault() reads ENTITIES/*.md and skips dotfiles, non-md, and malformed
content silently. resolveMemoryDir() honours per-agent isolation by routing
to agents/<id>/ when present. watchVault() coalesces rapid mutations on a
150ms debounce so seeding bursts trigger one reload."
```

---

## Task 8: Settings + SettingTab (`settings.ts`)

Phase 2 settings subset per design decision §3 of the answers above:
`memoryDir`, `memoryDirOutsideVault`, `agentId`, `defaultLayout` (locked to `force`),
`nodeChannels` (F2 toggle booleans), `maxNodesShown`. The remaining spec §5.1 fields
(`mkCliPath`, `wanderPreset`, `f3Layers`, `liveModeOnStartup`, `lastScrubbedAt`) get
added in their respective phases.

The setting tab has no vitest coverage (depends on the `obsidian` runtime); correctness is verified by `tsc --noEmit` and the manual smoke checklist in Task 13.

**Files:**
- Create: `packages/obsidian-mk-graph/src/settings.ts`

- [ ] **Step 8.1: Implement `src/settings.ts`**

```typescript
import { App, PluginSettingTab, Setting, type Plugin } from 'obsidian';

export interface NodeChannels {
  /** Toggle the F2 border-by-classification ring. */
  border: boolean;
  /** Toggle the F2 status-driven opacity. */
  opacity: boolean;
  /** Toggle the F2 log-citations sizing. */
  size: boolean;
}

export interface MkGraphSettings {
  /** Path to memory-kernel root dir. Relative paths resolve under the vault. */
  memoryDir: string;
  /** When true, memoryDir may be an absolute path outside the vault. */
  memoryDirOutsideVault: boolean;
  /** Empty string = shared mode. Otherwise routed via agents/<id>/. */
  agentId: string;
  /** Phase 2 always force; Phase 3 adds `timeline`, Phase 4 adds `radial-wander`. */
  defaultLayout: 'force';
  /** F2 channel toggles — fill (color by type) is always on. */
  nodeChannels: NodeChannels;
  /** Hard cap on nodes rendered before graceful degrade kicks in. */
  maxNodesShown: number;
}

export const DEFAULT_SETTINGS: MkGraphSettings = {
  memoryDir: '.mk',
  memoryDirOutsideVault: false,
  agentId: '',
  defaultLayout: 'force',
  nodeChannels: { border: true, opacity: true, size: true },
  maxNodesShown: 5000,
};

/**
 * Subset of `Plugin` we depend on — keeps this file decoupled from the
 * concrete plugin class so it can be imported without circular deps.
 */
export interface SettingsHost extends Plugin {
  settings: MkGraphSettings;
  saveSettings(): Promise<void>;
}

export class MkGraphSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Memory Kernel Graph — Settings' });

    new Setting(containerEl)
      .setName('Memory directory')
      .setDesc('Path to the memory-kernel store. Relative paths resolve under the vault root.')
      .addText((t) =>
        t
          .setPlaceholder('.mk')
          .setValue(this.host.settings.memoryDir)
          .onChange(async (value) => {
            this.host.settings.memoryDir = value.trim() || '.mk';
            await this.host.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Memory dir outside vault')
      .setDesc('Allow an absolute path outside the current Obsidian vault.')
      .addToggle((t) =>
        t.setValue(this.host.settings.memoryDirOutsideVault).onChange(async (value) => {
          this.host.settings.memoryDirOutsideVault = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Agent ID')
      .setDesc(
        'Per-agent isolation. Leave empty for shared mode. When set and agents/<id>/ exists, the plugin reads from that subdirectory.',
      )
      .addText((t) =>
        t
          .setPlaceholder('(shared)')
          .setValue(this.host.settings.agentId)
          .onChange(async (value) => {
            this.host.settings.agentId = value.trim();
            await this.host.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'F2 visual encoding' });

    new Setting(containerEl)
      .setName('Border = classification')
      .setDesc('Show the classification ring (PUBLIC=green, TEAM=blue, PERSONAL=orange, SECRET=red).')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.border).onChange(async (value) => {
          this.host.settings.nodeChannels.border = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Opacity = status')
      .setDesc('Dim non-active atoms (rejected, archived, superseded).')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.opacity).onChange(async (value) => {
          this.host.settings.nodeChannels.opacity = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Size = log(citations)')
      .setDesc('Scale node radius by inbound citation count.')
      .addToggle((t) =>
        t.setValue(this.host.settings.nodeChannels.size).onChange(async (value) => {
          this.host.settings.nodeChannels.size = value;
          await this.host.saveSettings();
        }),
      );

    containerEl.createEl('h3', { text: 'Performance' });

    new Setting(containerEl)
      .setName('Max nodes shown')
      .setDesc('Cap to keep the graph responsive. Default 5000; raise carefully.')
      .addText((t) =>
        t
          .setPlaceholder('5000')
          .setValue(String(this.host.settings.maxNodesShown))
          .onChange(async (value) => {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) {
              this.host.settings.maxNodesShown = Math.floor(n);
              await this.host.saveSettings();
            }
          }),
      );
  }
}
```

- [ ] **Step 8.2: Verify lint + build**

```bash
cd packages/obsidian-mk-graph && npm run lint && npm run build
```

Expected: clean.

- [ ] **Step 8.3: Commit**

```bash
git add packages/obsidian-mk-graph/src/settings.ts
git commit -m "feat(obsidian-mk-graph): add settings types and SettingTab

Phase 2 subset only: memoryDir, memoryDirOutsideVault, agentId, force
layout, F2 channel toggles, maxNodesShown. Other spec §5.1 fields land
with their owning phase (mkCliPath in Phase 4, scrubber state in Phase 3)."
```

---

## Task 9: Tooltip (`tooltip.ts`)

A single floating `<div>` reused across hovers. The renderer calls `showTooltip(node, x, y)` on hover, `hideTooltip()` on leave. Pure DOM — no Obsidian API dependency, so it's testable indirectly via the renderer smoke test in Task 10.

**Files:**
- Create: `packages/obsidian-mk-graph/src/tooltip.ts`

- [ ] **Step 9.1: Implement `src/tooltip.ts`**

```typescript
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
```

> **Note for the implementer:** `el.empty()`, `el.createDiv()`, and `setText()` are Obsidian helpers monkey-patched onto `HTMLElement` at runtime. They are *not* on `lib.dom.d.ts`; `obsidian`'s ambient types add them. If `tsc` errors here, ensure `obsidian` is in `devDependencies` (it is, per Task 1.3) and `tsconfig.json` does not set `types: []`.

- [ ] **Step 9.2: Verify build still produces `main.js`**

```bash
cd packages/obsidian-mk-graph && npm run build
```

- [ ] **Step 9.3: Verify lint**

```bash
cd packages/obsidian-mk-graph && npm run lint
```

- [ ] **Step 9.4: Commit**

```bash
git add packages/obsidian-mk-graph/src/tooltip.ts
git commit -m "feat(obsidian-mk-graph): add hover tooltip element"
```

---

## Task 10: Force-graph renderer (`renderer.ts`)

Wraps `vasturiano/force-graph` (Canvas 2D). The renderer:
1. Mounts a `force-graph` instance into the container.
2. Subscribes to `GraphState` and re-feeds `graphData` on every `replace()`.
3. Wires F2 encoders (`encoding.ts`) into force-graph's per-frame callbacks (`nodeColor`, `nodeVal`, `nodeCanvasObject`, `linkColor`, `linkWidth`, `linkLineDash`).
4. Bridges hover (`onNodeHover`) → tooltip (`tooltip.ts`).
5. Bridges click (`onNodeClick`) → caller-provided `onNodeClick(atom)` (the view layer maps it to Obsidian file-open).
6. Caps rendered nodes at `maxNodesShown` (graceful degrade: highest citation count wins).
7. Resizes on container resize via `ResizeObserver`.

This file is **not** unit-tested directly — it depends on browser DOM APIs, Canvas, and force-graph internals. Correctness is verified via:
- `tsc --noEmit` (signature checks on encoder calls)
- The manual smoke checklist in Task 13

**Files:**
- Create: `packages/obsidian-mk-graph/src/renderer.ts`

- [ ] **Step 10.1: Implement `src/renderer.ts`**

```typescript
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
import { SECRET_GLYPH } from './visual.js';
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

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const fg: any = (ForceGraph as any)()(container);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  fg.backgroundColor('rgba(0,0,0,0)');
  fg.nodeRelSize(1);
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
      ctx.fillStyle = 'var(--text-normal)' === '' ? '#FFFFFF' : '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.id, node.x ?? 0, (node.y ?? 0) + baseRadius + 2);
    }
    ctx.restore();
  });

  fg.linkColor((link: GraphLink) =>
    f2EdgeColor(linkAsRelation(link)),
  );
  fg.linkWidth((link: GraphLink) => f2EdgeWidth(linkAsRelation(link)));
  fg.linkLineDash((link: GraphLink) => f2EdgeDash(linkAsRelation(link)));
  // Render link opacity by drawing with rgba via linkColor would require
  // a hex→rgba conversion; force-graph also exposes a `linkOpacity` setter
  // applied multiplicatively after color resolution.
  fg.linkOpacity((link: GraphLink) => f2EdgeOpacity(linkAsRelation(link)));

  fg.onNodeHover((node: GraphNode | null, _prev: GraphNode | null) => {
    if (!node) {
      tooltip.hide();
      container.style.cursor = '';
      return;
    }
    container.style.cursor = 'pointer';
    // Use the renderer's getGraphBbox/screen2GraphCoords pair to compute
    // tooltip position; force-graph reports nodes in world coords.
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
```

> **Implementer note on `force-graph` types:** the npm package ships `.d.ts` but the API surface is large and many getters double as setters when called with arguments. Treating the instance as `any` (the `fg` cast above) is the documented pattern in the upstream README. If the project later adopts stricter types, replace the cast with an explicit interface in `src/types-force-graph.d.ts` — out of scope for Phase 2.

- [ ] **Step 10.2: Verify build**

```bash
cd packages/obsidian-mk-graph && npm run build
```

Expected: `main.js` rebuilt; bundle size jumps to ~250–500 KB now that force-graph is included.

- [ ] **Step 10.3: Verify lint**

```bash
cd packages/obsidian-mk-graph && npm run lint
```

Expected: clean (the `any` is locally disabled).

- [ ] **Step 10.4: Commit**

```bash
git add packages/obsidian-mk-graph/src/renderer.ts
git commit -m "feat(obsidian-mk-graph): add force-graph renderer with F2 encoding

Wraps vasturiano/force-graph, wires every F2 channel through the pure
encoders, manages tooltip on hover, surfaces clicks to caller, caps node
count via maxNodesShown with citation-based graceful degrade, and resizes
via ResizeObserver. Renderer cleanup is one destroy() call."
```

---

## Task 11: ItemView (`view.ts`)

The Obsidian-side mount: an `ItemView` subclass that owns the renderer's lifecycle, hooks the file watcher, and translates click events to `workspace.openLinkText()`. Lives in its own leaf (right pane by default). View type id: `mk-graph-view`.

**Files:**
- Create: `packages/obsidian-mk-graph/src/view.ts`

- [ ] **Step 11.1: Implement `src/view.ts`**

```typescript
import { ItemView, WorkspaceLeaf, normalizePath, type App } from 'obsidian';
import path from 'node:path';
import { GraphState } from './graph-state.js';
import { readVault, watchVault, resolveMemoryDir, type Watcher } from './data-loader.js';
import { createRenderer, type RendererHandle } from './renderer.js';
import type { MkGraphSettings } from './settings.js';
import type { ParsedAtom } from './atom-parser.js';

export const MK_GRAPH_VIEW_TYPE = 'mk-graph-view';

export interface ViewHost {
  app: App;
  settings: MkGraphSettings;
}

export class MkGraphView extends ItemView {
  private state: GraphState = new GraphState();
  private renderer: RendererHandle | null = null;
  private watcher: Watcher | null = null;

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

    this.renderer = createRenderer(container, {
      state: this.state,
      settings: this.host.settings,
      onNodeClick: (atom) => this.openAtom(atom),
    });

    await this.reloadFromDisk();

    const memDir = this.resolveMemoryDirAbsolute();
    if (memDir) {
      this.watcher = watchVault(memDir, () => {
        // Coalesce + reload; errors land in the console rather than crash the view.
        void this.reloadFromDisk();
      });
    }
  }

  async onClose(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  /** Public so the plugin entry can call it from the "Reload" command. */
  async reloadFromDisk(): Promise<void> {
    const memDir = this.resolveMemoryDirAbsolute();
    if (!memDir) {
      this.state.replace([]);
      return;
    }
    const atoms = await readVault(memDir);
    this.state.replace(atoms);
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
    }
    await this.host.app.workspace.openLinkText(normalizePath(rel), '', false);
  }
}
```

- [ ] **Step 11.2: Verify lint + build**

```bash
cd packages/obsidian-mk-graph && npm run lint && npm run build
```

Expected: clean; `main.js` still builds.

- [ ] **Step 11.3: Commit**

```bash
git add packages/obsidian-mk-graph/src/view.ts
git commit -m "feat(obsidian-mk-graph): add MkGraphView ItemView

Mounts the renderer in a leaf, drives state from readVault on open and
on file-watcher events, and translates node clicks to
workspace.openLinkText() so Obsidian opens the atom .md in a regular pane.
Honours memoryDirOutsideVault, agentId, and per-agent isolation."
```

---

## Task 12: Plugin entry (`main.ts` — full implementation)

Replaces the Task 1 stub with the real plugin class: load/save settings, register the view, register the "Open Memory Kernel Graph" command, register the SettingTab, and provide a "Reload graph" command.

**Files:**
- Modify: `packages/obsidian-mk-graph/src/main.ts`

- [ ] **Step 12.1: Replace `src/main.ts` with the real implementation**

```typescript
import { Plugin, WorkspaceLeaf } from 'obsidian';
import { MkGraphView, MK_GRAPH_VIEW_TYPE } from './view.js';
import { DEFAULT_SETTINGS, MkGraphSettingTab, type MkGraphSettings } from './settings.js';

export default class MkGraphPlugin extends Plugin {
  settings: MkGraphSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(MK_GRAPH_VIEW_TYPE, (leaf) => new MkGraphView(leaf, this));

    this.addRibbonIcon('git-branch', 'Open Memory Kernel Graph', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-mk-graph',
      name: 'Open Memory Kernel Graph',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'reload-mk-graph',
      name: 'Reload Memory Kernel Graph from disk',
      checkCallback: (checking) => {
        const view = this.getActiveGraphView();
        if (!view) return false;
        if (!checking) void view.reloadFromDisk();
        return true;
      },
    });

    this.addSettingTab(new MkGraphSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    // Obsidian unloads registered views automatically; nothing else to clean up.
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<MkGraphSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      nodeChannels: {
        ...DEFAULT_SETTINGS.nodeChannels,
        ...(stored?.nodeChannels ?? {}),
      },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(MK_GRAPH_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: MK_GRAPH_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private getActiveGraphView(): MkGraphView | null {
    const leaves = this.app.workspace.getLeavesOfType(MK_GRAPH_VIEW_TYPE);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    return view instanceof MkGraphView ? view : null;
  }
}
```

- [ ] **Step 12.2: Verify lint + build**

```bash
cd packages/obsidian-mk-graph && npm run lint && npm run build
```

Expected: clean; final `main.js` produced (~300–600 KB depending on force-graph version).

- [ ] **Step 12.3: Commit**

```bash
git add packages/obsidian-mk-graph/src/main.ts
git commit -m "feat(obsidian-mk-graph): wire plugin entry — view, commands, settings

Registers MkGraphView, ribbon icon, 'Open Memory Kernel Graph' command,
'Reload from disk' command, and the SettingTab. Settings persist through
Obsidian's loadData/saveData with a nested-merge for nodeChannels so a
new toggle never strands users on an old settings shape."
```

---

## Task 13: Test fixture vault

A minimal but representative fixture vault under `test/fixtures/small-vault/` used by the manual smoke test in Task 14 and as an in-repo example. Twenty atoms covering every type, every status, every classification, and a mix of relation kinds + sources.

**Files:**
- Create: `packages/obsidian-mk-graph/test/fixtures/small-vault/ENTITIES/*.md` (20 files)
- Create: `packages/obsidian-mk-graph/test/fixtures/small-vault/EPISODES/EP-fixture-001.md`
- Create: `packages/obsidian-mk-graph/test/fixtures/README.md`

- [ ] **Step 13.1: Generate the fixture atoms via a one-shot script**

Create `packages/obsidian-mk-graph/test/fixtures/generate-small-vault.mjs` (committed alongside the fixture so regen is reproducible):

```javascript
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'small-vault');
const ents = path.join(root, 'ENTITIES');
const eps = path.join(root, 'EPISODES');
mkdirSync(ents, { recursive: true });
mkdirSync(eps, { recursive: true });

const atomTypes = [
  'fact', 'belief', 'decision', 'open_question', 'preference',
  'constraint', 'procedure', 'entity_summary', 'conflict',
];
const statuses = [
  'active', 'active', 'active', 'active', 'accepted',
  'draft', 'rejected', 'superseded', 'archived', 'resolved',
];
const classifications = ['PUBLIC', 'TEAM', 'TEAM', 'TEAM', 'PERSONAL', 'SECRET'];
const relationTypes = ['extends', 'supports', 'contradicts', 'caused_by', 'related'];
const sources = ['manual', 'extracted', 'enriched', undefined];

const atoms = [];
for (let i = 0; i < 20; i++) {
  const type = atomTypes[i % atomTypes.length];
  const status = statuses[i % statuses.length];
  const classification = classifications[i % classifications.length];
  const day = (i % 27) + 1;
  const dd = String(day).padStart(2, '0');
  const id = `${type.toUpperCase().slice(0, 4)}-2026-04-${dd}-FIX${String(i).padStart(2, '0')}-aa${String(i).padStart(2, '0')}`;
  atoms.push({ id, type, status, classification, day });
}

for (let i = 0; i < atoms.length; i++) {
  const a = atoms[i];
  const linkCount = (i % 4) + (i < 5 ? 0 : 1);
  const rels = [];
  for (let r = 0; r < linkCount; r++) {
    const targetIdx = (i + r + 3) % atoms.length;
    if (targetIdx === i) continue;
    rels.push({
      target: atoms[targetIdx].id,
      type: relationTypes[(i + r) % relationTypes.length],
      confidence: 0.5 + ((i + r) % 5) * 0.1,
      weight: 0.6 + ((i + r) % 4) * 0.3,
      source: sources[(i + r) % sources.length],
    });
  }

  const lines = [];
  lines.push('---');
  lines.push(`id: ${a.id}`);
  lines.push(`type: ${a.type}`);
  lines.push(`status: ${a.status}`);
  lines.push(`confidence: 0.${8 + (i % 2)}`);
  lines.push(`created_at: "2026-04-${String(a.day).padStart(2, '0')}T10:00:00Z"`);
  lines.push(`updated_at: "2026-04-${String(a.day).padStart(2, '0')}T10:00:00Z"`);
  lines.push('ttl_days: null');
  lines.push(`classification: ${a.classification}`);
  lines.push('scope:');
  lines.push(`  tags: [fixture, ${a.type}]`);
  if (rels.length > 0) {
    lines.push('relations:');
    for (const r of rels) {
      lines.push(`  - target: ${r.target}`);
      lines.push(`    type: ${r.type}`);
      lines.push(`    confidence: ${r.confidence.toFixed(2)}`);
      lines.push(`    weight: ${r.weight.toFixed(2)}`);
      if (r.source) lines.push(`    source: ${r.source}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(`Body for fixture atom ${a.id}.`);
  lines.push('');
  writeFileSync(path.join(ents, `${a.id}.md`), lines.join('\n'));
}

const epBody = [
  '---',
  'session_id: EP-fixture-001',
  'started_at: "2026-04-15T09:00:00Z"',
  'ended_at: "2026-04-15T11:00:00Z"',
  'tags: [fixture]',
  'provenance_atoms:',
  ...atoms.slice(0, 4).map((a) => `  - ${a.id}`),
  '---',
  '',
  'Fixture episode for manual smoke testing.',
  '',
].join('\n');
writeFileSync(path.join(eps, 'EP-fixture-001.md'), epBody);

console.log(`Wrote ${atoms.length} atoms to ${ents}`);
console.log(`Wrote 1 episode to ${eps}`);
```

- [ ] **Step 13.2: Run the generator**

```bash
cd packages/obsidian-mk-graph && node test/fixtures/generate-small-vault.mjs
ls test/fixtures/small-vault/ENTITIES | wc -l
```

Expected: `20`.

- [ ] **Step 13.3: Verify a representative atom round-trips through `parseAtomFile`**

Create `packages/obsidian-mk-graph/test/fixtures-smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAtomFile } from '../src/atom-parser.js';

describe('fixture vault', () => {
  it('every fixture file parses cleanly', () => {
    const dir = path.join(__dirname, 'fixtures', 'small-vault', 'ENTITIES');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const f of files) {
      const content = readFileSync(path.join(dir, f), 'utf-8');
      const atom = parseAtomFile(content, path.join(dir, f));
      expect(atom, `parsing ${f}`).not.toBeNull();
    }
  });
});
```

- [ ] **Step 13.4: Run tests**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all tests pass including the fixture smoke.

- [ ] **Step 13.5: Write `test/fixtures/README.md`**

```markdown
# Fixture vault — small-vault

Twenty hand-generated atoms (every type × every status × every classification) plus one episode. Used by:

- `test/fixtures-smoke.test.ts` — round-trip every atom through `parseAtomFile`.
- The manual smoke checklist in `docs/superpowers/plans/2026-04-30-obsidian-mk-graph-phase2-plugin-scaffold.md` (Task 14).
- Future phases (Phase 3 / Phase 4) extend this vault with `events.ndjson` and wander seeds.

## Regenerate

```bash
node test/fixtures/generate-small-vault.mjs
```

The generator is deterministic — re-running produces an identical set of files.
```

- [ ] **Step 13.6: Commit**

```bash
git add packages/obsidian-mk-graph/test/fixtures packages/obsidian-mk-graph/test/fixtures-smoke.test.ts
git commit -m "test(obsidian-mk-graph): add 20-atom fixture vault + smoke test

Hand-generated fixture covers every atom type, every status, every
classification, plus a mix of relation kinds and provenance sources.
Deterministic generator script committed for reproducible regen."
```

---

## Task 14: Manual smoke test + README

Phase 2 has no Playwright-electron tests yet (Phase 5). The deliverable for Phase 2 is verified by walking the manual smoke checklist below in a real Obsidian instance and recording results in the README. This step is not skippable — it's the only way to confirm the F2 encoding actually renders.

**Files:**
- Create: `packages/obsidian-mk-graph/README.md`
- Create: `packages/obsidian-mk-graph/CHANGELOG.md`
- Create: `packages/obsidian-mk-graph/SMOKE_TEST.md`

- [ ] **Step 14.1: Write the smoke checklist**

Create `packages/obsidian-mk-graph/SMOKE_TEST.md`:

```markdown
# Smoke test — Phase 2 acceptance

Run before tagging `obsidian-mk-graph@0.1.0`. All steps must pass.

## Setup

1. Build the plugin:
   ```bash
   cd packages/obsidian-mk-graph
   npm install
   npm run build
   ```
2. Make a temporary vault:
   ```bash
   mkdir -p /tmp/mk-graph-smoke && cd /tmp/mk-graph-smoke
   ```
3. Copy the fixture as the memory dir:
   ```bash
   mkdir -p .mk
   cp -r <repo>/packages/obsidian-mk-graph/test/fixtures/small-vault/* .mk/
   ```
4. Symlink the plugin into the vault:
   ```bash
   mkdir -p .obsidian/plugins/obsidian-mk-graph
   ln -sf <repo>/packages/obsidian-mk-graph/main.js .obsidian/plugins/obsidian-mk-graph/main.js
   ln -sf <repo>/packages/obsidian-mk-graph/manifest.json .obsidian/plugins/obsidian-mk-graph/manifest.json
   ln -sf <repo>/packages/obsidian-mk-graph/styles.css .obsidian/plugins/obsidian-mk-graph/styles.css
   ```
5. Open `/tmp/mk-graph-smoke` in Obsidian. Trust the vault. Enable Community Plugins. Enable "Memory Kernel Graph".

## Checklist

- [ ] **S1: View opens.** Click the ribbon icon (git-branch). The right pane opens with the graph view.
- [ ] **S2: Nodes render.** 20 nodes visible, distributed by force layout. No console errors.
- [ ] **S3: F2 color = type.** Hover several nodes — tooltip shows the type, fill color matches the spec palette (fact=green, belief=blue, decision=orange, etc.).
- [ ] **S4: F2 border = classification.** SECRET atoms (the orange-red border with 🔒 glyph) are visually distinct from TEAM (blue border) and PUBLIC (green).
- [ ] **S5: F2 opacity = status.** Rejected/archived atoms appear dimmer than active ones.
- [ ] **S6: F2 size = log-citations.** Atoms with more inbound edges appear larger.
- [ ] **S7: Edges encode type/source/confidence.** Different edge colors visible; some edges dashed (extracted) or dotted (enriched). Hover an edge — no crash even if force-graph doesn't show a tooltip on edges.
- [ ] **S8: Click opens atom file.** Click any node — the atom .md file opens in the main pane.
- [ ] **S9: Settings persist.** Open settings, toggle "Border = classification" off, close + reopen Obsidian — toggle remains off, borders stay hidden.
- [ ] **S10: Live mode picks up changes.** With the view open, edit one atom file from disk (`echo >> .mk/ENTITIES/<one>.md`), save — within ~1 second, the graph re-renders.
- [ ] **S11: Per-agent isolation routes correctly.** Create `.mk/agents/test/ENTITIES/<one-new>.md`, set Agent ID = `test` in settings. Reload graph — only the new atom is shown (not the 20 base atoms).
- [ ] **S12: Reload command works.** Use the command palette → "Reload Memory Kernel Graph from disk" — graph re-renders without restarting Obsidian.
- [ ] **S13: maxNodesShown degrades gracefully.** Set max to 10. Reload graph. Only 10 nodes render and they're the most-cited (highest inbound).
- [ ] **S14: View closes cleanly.** Close the leaf, reopen via command. No memory leak warning in console; no orphaned canvas elements (inspect DOM).

## Pass/fail

Record results inline (replace `[ ]` with `[x]` or `[FAIL: <reason>]`). All must pass before Task 14.5 commit.
```

- [ ] **Step 14.2: Walk the checklist in a real Obsidian instance**

Open Obsidian Sandbox or a fresh vault, follow `SMOKE_TEST.md` end-to-end, and tick each box. If any step fails, return to the relevant earlier task and fix before proceeding. Do not gloss over failures.

- [ ] **Step 14.3: Commit the completed checklist**

```bash
git add packages/obsidian-mk-graph/SMOKE_TEST.md
git commit -m "test(obsidian-mk-graph): add Phase 2 smoke test checklist (passing)"
```

- [ ] **Step 14.4: Write `packages/obsidian-mk-graph/README.md`**

```markdown
# Memory Kernel Graph for Obsidian

A typed event-sourced graph view for [memory-kernel](https://github.com/mainion-ai/memory-kernel) atoms. Reads your `.mk/ENTITIES/*.md` files and renders them as a force-directed graph with the F2 visual encoding:

- **Node color** = atom type (fact / belief / decision / …)
- **Node size** = inbound citation count (log scale)
- **Node border** = classification (PUBLIC / TEAM / PERSONAL / SECRET — SECRET also gets a 🔒 glyph)
- **Node opacity** = status (active = 1.0, archived = 0.2, …)
- **Edge color** = relation type (extends / supports / contradicts / …)
- **Edge width** = relation weight
- **Edge dash** = source (manual = solid, extracted = dashed, enriched = dotted)
- **Edge opacity** = relation confidence

Read-only. Click a node to open its atom file. Hover for a tooltip with id, type, status, classification, citations, and tags.

## Status

`v0.1.0` — Phase 2 of the [obsidian-mk-graph design spec](../../docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md). Force-directed layout only; timeline, scrubber, and wander-visualisation come in Phases 3 / 4.

## Install (BRAT, recommended for v0.x)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. In BRAT settings, "Add Beta Plugin" → `mainion-ai/memory-kernel` (path `packages/obsidian-mk-graph`).
3. Enable "Memory Kernel Graph" under Community Plugins.

## Install (manual, build from source)

```bash
git clone git@github.com:mainion-ai/memory-kernel.git
cd memory-kernel/packages/obsidian-mk-graph
npm install
npm run build

# Symlink into your vault
mkdir -p <vault>/.obsidian/plugins/obsidian-mk-graph
ln -sf "$PWD/main.js"        <vault>/.obsidian/plugins/obsidian-mk-graph/main.js
ln -sf "$PWD/manifest.json"  <vault>/.obsidian/plugins/obsidian-mk-graph/manifest.json
ln -sf "$PWD/styles.css"     <vault>/.obsidian/plugins/obsidian-mk-graph/styles.css
```

Reload Obsidian and enable the plugin.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Memory directory | `.mk` | Path to memory-kernel store. Relative paths resolve under the vault. |
| Memory dir outside vault | off | Allow absolute paths outside the current vault. |
| Agent ID | (empty) | Per-agent isolation — when set and `agents/<id>/` exists, the plugin reads from there. |
| Border = classification | on | Toggle the F2 classification ring. |
| Opacity = status | on | Toggle the F2 status dimming. |
| Size = log(citations) | on | Toggle the F2 log-scale node sizing. |
| Max nodes shown | 5000 | Hard cap; above this the most-cited nodes win. |

## Commands

- **Open Memory Kernel Graph** — opens the graph view in the right pane.
- **Reload Memory Kernel Graph from disk** — re-reads `ENTITIES/*.md`.

## Roadmap

- v0.2.0 — Phase 3: events.ndjson ingestion, replay scrubber, timeline layout, diff mode.
- v0.3.0 — Phase 4: wander visualisation (heatmap + ripple + constellation), `mk` subprocess integration.
- v1.0.0 — Phase 5: F3 layers, performance hardening, Community Plugins submission.

## License

Apache-2.0. See `LICENSE`.
```

- [ ] **Step 14.5: Write `packages/obsidian-mk-graph/CHANGELOG.md`**

```markdown
# obsidian-mk-graph changelog

This file is independent of the `memory-kernel` core changelog (per project convention — plugin manifest version drifts with the plugin only).

## [0.1.0] — 2026-04-30

### Added
- Initial plugin scaffold under `packages/obsidian-mk-graph/`.
- Read-only force-directed graph view of `<memoryDir>/ENTITIES/*.md`.
- F2 visual encoding (color=type, size=log-citations, border=classification, opacity=status; edge color=type, width=weight, dash=source, opacity=confidence).
- Hover tooltip + click-to-open-atom-file.
- File watcher for live updates when atom files change on disk.
- Per-agent isolation routing (`agents/<id>/` resolution).
- Settings tab with channel toggles, agent id, memory dir, max-nodes cap.
- Plugin commands: open view, reload from disk.
- 20-atom fixture vault for smoke testing.

### Notes
- No `events.ndjson` ingestion yet — Phase 3.
- No wander visualisation yet — Phase 4.
- No Community Plugins submission — Phase 5; install via BRAT or manual.
```

- [ ] **Step 14.6: Commit README + CHANGELOG**

```bash
git add packages/obsidian-mk-graph/README.md packages/obsidian-mk-graph/CHANGELOG.md
git commit -m "docs(obsidian-mk-graph): add README and CHANGELOG for v0.1.0"
```

---

## Task 15: Release tag and final verification

- [ ] **Step 15.1: Run the full test suite from the repo root**

```bash
npm test
```

Expected: existing 1100+ mk-core tests pass (Phase 2 didn't touch mk-core).

- [ ] **Step 15.2: Run the plugin test suite**

```bash
cd packages/obsidian-mk-graph && npm test
```

Expected: all parser, citation, encoding, graph-state, data-loader, and fixture-smoke tests pass.

- [ ] **Step 15.3: Verify the production bundle builds**

```bash
cd packages/obsidian-mk-graph && npm run build
ls -lh main.js
```

Expected: `main.js` exists, minified, sourcemap inline disabled (the `prod` branch in `esbuild.config.mjs`).

- [ ] **Step 15.4: Tag the plugin release**

The plugin tag is namespaced to keep mk-core's `v1.x.y` tag space clean (per CLAUDE.md: plugin manifest version is independent of mk core).

```bash
git tag -a obsidian-mk-graph-v0.1.0 -m "obsidian-mk-graph v0.1.0 — Phase 2 plugin scaffold + static graph"
```

> Do **not** push the tag from the worktree; pushing happens after the user reviews the plan output. Mention the tag in the final summary.

- [ ] **Step 15.5: Update top-level CHANGELOG with a one-line pointer**

In repo-root `CHANGELOG.md`, under `[Unreleased]`, add:

```markdown
### Added
- New first-party Obsidian plugin: `packages/obsidian-mk-graph` (v0.1.0). See [packages/obsidian-mk-graph/CHANGELOG.md](packages/obsidian-mk-graph/CHANGELOG.md).
```

(No mk-core version bump — Phase 2 made zero mk-core changes.)

- [ ] **Step 15.6: Commit the CHANGELOG pointer**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note obsidian-mk-graph v0.1.0 plugin

Plugin lives under packages/obsidian-mk-graph and ships independently of
the mk-core release cadence. Phase 2 of the obsidian-mk-graph spec."
```

---

## Acceptance for Phase 2

When all tasks check off:

1. `packages/obsidian-mk-graph/main.js` builds reproducibly via `npm run build`.
2. `npm test` (root) and `cd packages/obsidian-mk-graph && npm test` both pass.
3. The smoke checklist (`SMOKE_TEST.md`) passes end-to-end against the fixture vault in a real Obsidian.
4. Tag `obsidian-mk-graph-v0.1.0` exists locally and is ready to push.
5. mk-core remained at `v1.17.1` (no version bump).

This unblocks Phase 3 (events.ndjson + ReplayEngine + scrubber UX), which extends `data-loader.ts` with NDJSON ingestion, adds `replay-engine.ts` and `scrubber.ts`, and introduces the timeline layout. The plugin's `MkGraphView` already routes through `GraphState.replace()` — Phase 3 plugs in a new replayed-state source without touching the renderer.

---

## Self-review

**Spec coverage check** (against `docs/superpowers/specs/2026-04-28-obsidian-mk-graph-design.md` §6 row 2 — "Plugin scaffold + static graph"):

| Spec requirement | Covered by |
|---|---|
| `packages/obsidian-mk-graph/` scaffold | Task 1 |
| Manifest | Task 1.2 |
| Settings UI | Task 8 |
| DataLoader | Task 7 |
| Force layout | Task 10 (uses force-graph default forces; settings tuning deferred — see "Out of scope" carve-out) |
| F2 encoding | Tasks 3 + 5 |
| Hover/click | Tasks 9 + 10 + 11 |
| First usable graph in Obsidian | Tasks 11 + 12 + 14 |

**Placeholder scan:** no "TBD", "TODO", "implement later", "similar to Task N" without code, or unspecified test bodies. All steps include either exact code or exact commands.

**Type consistency:** `ParsedAtom` shape used in `atom-parser.ts`, `citations.ts`, `encoding.ts`, `graph-state.ts`, `data-loader.ts`, `view.ts`, and tests is identical. `MkGraphSettings` shape matches between `settings.ts` and `view.ts`. `GraphLink.source_kind` (renamed from `source` to avoid collision with force-graph's link-source semantics) is used consistently in `graph-state.ts` and `renderer.ts`.

**Force-directed layout tuning carve-out:** Spec §5.3 names tuned defaults (charge -100, link distance 60, collision radius 14). Task 10 uses force-graph's defaults rather than these specific values. This is a small intentional gap — tuning needs visual A/B testing best done after the fixture renders for the first time, and the difference does not affect Phase 2's "first usable graph" deliverable. **Track:** add an `forceTuning` settings group + apply the spec values in Phase 3 alongside the layout switcher (where the timeline layout exposes its own tuning panel).
