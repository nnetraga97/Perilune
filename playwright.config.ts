import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium',
      args: [
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--js-flags=--expose-gc',
      ],
    },
  },
  webServer: {
    command: 'npm run build >/dev/null 2>&1 && npm run preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
