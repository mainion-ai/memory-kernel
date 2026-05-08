import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Per-file environment override: anything ending in `.dom.test.ts`
    // runs under jsdom for DOM-dependent UI components (scrubber, etc.).
    environmentMatchGlobs: [
      ['test/**/*.dom.test.ts', 'jsdom'],
    ],
  },
});
