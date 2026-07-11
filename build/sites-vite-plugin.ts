import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Packages the static game as a Cloudflare Worker for OpenAI Sites. */
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: 'sites',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      await rm(resolve(root, 'dist'), { recursive: true, force: true });
    },
    async closeBundle() {
      const dist = resolve(root, 'dist');
      const hostingConfig = resolve(root, '.openai', 'hosting.json');
      const metadataDirectory = resolve(dist, '.openai');
      const serverDirectory = resolve(dist, 'server');

      await rm(metadataDirectory, { recursive: true, force: true });
      await mkdir(metadataDirectory, { recursive: true });
      await mkdir(serverDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(metadataDirectory, 'hosting.json'));
      }

      await writeFile(
        resolve(serverDirectory, 'index.js'),
        [
          '/** OpenAI Sites / Cloudflare Worker entry point. */',
          'export default {',
          '  async fetch(request, env) {',
          '    const url = new URL(request.url);',
          '    const assetRequest = url.pathname === "/"',
          '      ? new Request(new URL("/index.html", url), request)',
          '      : request;',
          '    const response = await env.ASSETS.fetch(assetRequest);',
          '    const contentType = response.headers.get("content-type") || "";',
          '    if (!contentType.includes("text/html")) return response;',
          '    const origin = new URL(request.url).origin;',
          '    const html = (await response.text()).replaceAll("__SITE_ORIGIN__", origin);',
          '    return new Response(html, response);',
          '  },',
          '};',
          '',
        ].join('\n'),
        'utf8',
      );
    },
  };
}
