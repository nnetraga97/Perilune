import { defineConfig } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';

const sentryUpload = process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
  ? sentryVitePlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
  })
  : null;

export default defineConfig({
  base: './',
  plugins: sentryUpload ? [sentryUpload] : [],
  define: {
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL ?? ''),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(
      process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
    ),
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ''),
    __PERILUNE_RELEASE__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'development'),
    __VERCEL_DEPLOYED__: JSON.stringify(process.env.VERCEL === '1'),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  server: {
    port: 5173,
    headers: {
      // COOP/COEP enable SharedArrayBuffer if we adopt it later.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
  },
});
