import { defineConfig, loadEnv, type Plugin } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';

function flightDirectorDevApi(): Plugin {
  return {
    name: 'perilune-flight-director-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/flight-director', async (request, response) => {
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of request) {
            chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
            else if (value !== undefined) headers.set(key, value);
          }
          const bytes = chunks.length ? Buffer.concat(chunks) : null;
          const webRequest = new Request('http://127.0.0.1/api/flight-director', {
            method: request.method ?? 'GET',
            headers,
            body: bytes?.length ? new Uint8Array(bytes) : undefined,
          });
          const route = await import('./api/flight-director.ts');
          const webResponse = await route.default.fetch(webRequest);
          response.statusCode = webResponse.status;
          webResponse.headers.forEach((value, key) => response.setHeader(key, value));
          response.end(Buffer.from(await webResponse.arrayBuffer()));
        } catch {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: false, error: { code: 'DEV_API_ERROR', message: 'Local API failed' } }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  for (const name of ['OPENAI_API_KEY', 'REDIS_URL'] as const) {
    if (!process.env[name] && fileEnv[name]) process.env[name] = fileEnv[name];
  }
  const sentryUpload = process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
    })
    : null;
  return ({
  base: './',
  plugins: [flightDirectorDevApi(), ...(sentryUpload ? [sentryUpload] : [])],
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
});
