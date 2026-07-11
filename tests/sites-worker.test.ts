import { describe, expect, it } from 'vitest';

describe('Sites worker', () => {
  it('serves index.html for the site root', async () => {
    const workerModulePath: string = '../dist/server/index.js';
    const { default: worker } = await import(workerModulePath);
    let requestedPath = '';
    const env = {
      ASSETS: {
        async fetch(request: Request) {
          requestedPath = new URL(request.url).pathname;
          return new Response('<title>Perilune</title>', {
            headers: { 'content-type': 'text/html' },
          });
        },
      },
    };

    await worker.fetch(new Request('https://example.test/'), env);

    expect(requestedPath).toBe('/index.html');
  });
});
