import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Golden summaries live next to the tests that produce them.
    snapshotFormat: {
      printBasicPrototype: false,
    },
  },
});
