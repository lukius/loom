import { defineConfig } from 'vitest/config';

// Node 26 ships its own localStorage global, which is undefined without a
// backing file and hides the test environment's. Older versions reject the flag.
const flag = '--no-experimental-webstorage';
const execArgv = process.allowedNodeEnvironmentFlags.has(flag) ? [flag] : [];

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['web/**/*.test.js'],
    setupFiles: ['./web/test-setup.js'],
    passWithNoTests: true,
    execArgv,
  },
});
