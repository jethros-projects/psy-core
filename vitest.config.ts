import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [
      'tests/canonical.test.ts',
      'tests/hash-chain.test.ts',
      'tests/rotation.test.ts',
      'tests/store.test.ts',
      'tests/verify.test.ts',
    ],
    globals: false,
    pool: 'forks',
    testTimeout: 15000,
  },
});
