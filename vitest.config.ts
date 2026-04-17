import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // The openclaw plugin imports from 'memory-kernel' (npm package).
      // In development, redirect to local source so isolation APIs are available.
      'memory-kernel': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    timeout: 10000,
  },
});
