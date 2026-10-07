import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    // Files share one replica set but each uses its own database, so they can run in parallel.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
