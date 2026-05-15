import { defineConfig, devices } from '@playwright/test';

// Use a non-default port so this suite never collides with a developer's
// hand-run `python loom.py` (which binds 8000). The server reads
// LOOM_PORT and obeys it; see src/loom.py.
const PORT = 8766;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Resolve the Python interpreter via PATH (matches the README's
    // `cd src && python loom.py`). Falls back to `python3` so the
    // suite still runs on systems where only python3 is on PATH.
    command:
      'cd src && (command -v python >/dev/null 2>&1 && python loom.py || python3 loom.py)',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    env: { LOOM_PORT: String(PORT) },
  },
});
