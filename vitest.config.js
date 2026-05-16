import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['web/**/*.test.js'],
    setupFiles: ['./web/test-setup.js'],
    passWithNoTests: true,
  },
});
