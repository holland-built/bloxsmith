import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One retry absorbs rare races against a live server (e.g. a global keydown
  // listener not yet attached when Ctrl/Cmd-K is pressed under parallel load).
  // Deterministic failures still fail both attempts — retries never hide real bugs.
  retries: 1,
  use: {
    baseURL: 'http://localhost:8080',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
