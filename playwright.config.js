import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, timeout: 45000,
  use: { baseURL: 'http://localhost:8788', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: { command: 'WRANGLER_LOG_PATH=/tmp/cronly-e2e-wrangler.log npm run dev:local -- --port 8788 --persist-to /tmp/cronly-e2e-state', url: 'http://localhost:8788/health', reuseExistingServer: false, timeout: 60000 }
});
