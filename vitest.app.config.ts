import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['jarvis/**/*.vitest.test.ts', 'app/**/*.vitest.test.ts', 'scripts/**/*.vitest.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15_000,
    passWithNoTests: false,
  },
});
