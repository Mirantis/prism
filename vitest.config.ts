import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-utils/**'],
      thresholds: {
        statements: 52,
        branches: 47,
        functions: 50,
        lines: 52,
      },
    },
    setupFiles: ['src/test-utils/setup.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});
