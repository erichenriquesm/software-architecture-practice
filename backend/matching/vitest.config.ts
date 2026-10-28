import { defineConfig } from 'vitest/config';

const integration = process.env.TEST_SUITE === 'integration';

export default defineConfig({
  test: {
    include: integration ? ['test/integration/**/*.spec.ts'] : ['test/unit/**/*.spec.ts'],
    passWithNoTests: true,
    fileParallelism: !integration,
    testTimeout: integration ? 60_000 : 5_000,
    hookTimeout: integration ? 60_000 : 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
