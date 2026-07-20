import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const linuxChromium = '/opt/pw-browsers/chromium';
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = existsSync(linuxChromium)
  ? linuxChromium
  : existsSync(macChrome)
    ? macChrome
    : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath,
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
