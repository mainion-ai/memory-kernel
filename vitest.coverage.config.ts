import { defineConfig, mergeConfig, configDefaults } from 'vitest/config';
import baseConfig from './vitest.config.js';

/**
 * Coverage-only vitest config (#390). Run via `npm run test:coverage`.
 *
 * Why a separate config: in-process v8 coverage instruments the vitest process,
 * but the **subprocess CLI e2e tests** (listed below) spawn `node dist/cli/mk.js`
 * — the child is NOT instrumented, so those tests contribute ZERO in-process
 * coverage, AND they time out under the instrumentation/load overhead. Excluding
 * them makes the coverage run fast + reliable and loses no coverage signal.
 *
 * Consequence: `src/cli/**` and `src/mcp/server.ts` UNDER-REPORT here — they are
 * exercised end-to-end by the excluded subprocess suite, just invisibly to v8.
 * This is a measurement artifact, not a real gap. See `test/README.md` (the test
 * layer taxonomy, #391). When the e2e tests move to a `test/e2e/` dir (#391),
 * replace this explicit list with a single directory glob.
 */
const SUBPROCESS_E2E_TESTS = [
  'test/cli-compact-json.test.ts',
  'test/cli-deprecation-e2e.test.ts',
  'test/cli-doctor-e2e.test.ts',
  'test/cli-eval-e2e.test.ts',
  'test/cli-extract-errors.test.ts',
  'test/cli-init-cron-e2e.test.ts',
  'test/cli-json.test.ts',
  'test/cli-observe-e2e.test.ts',
  'test/closure.test.ts',
  'test/doctor-discover-wrappers.test.ts',
  'test/export-obsidian-cli.test.ts',
  'test/grounding.test.ts',
  'test/lint-composition.test.ts',
  'test/lint.test.ts',
  'test/schemas.test.ts',
  'test/tag-whitespace.test.ts',
  'test/upgrade-installer.test.ts',
];

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, ...SUBPROCESS_E2E_TESTS],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary', 'html'],
        reportsDirectory: 'coverage',
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.d.ts',
          'dist/**',
          'test/**',
          'bench/**',
          'scripts/**',
          '**/*.config.*',
          'packages/**/dist/**',
        ],
      },
    },
  }),
);
