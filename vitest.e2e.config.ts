import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    globals: false,
    pool: 'forks',
    testTimeout: 30_000,
  },
});
