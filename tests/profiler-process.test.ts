import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  allocateLoopbackPort,
  stopProcessTree,
  waitForServerOrExit,
} from '../scripts/lib/profiler-process.mjs';

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', timeout: 200 }, (response) => {
      response.resume();
      resolve(true);
    });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
    req.end();
  });
}

describe('profiler process ownership', () => {
  it('allocates an available ephemeral loopback port', async () => {
    const first = await allocateLoopbackPort();
    expect(first).toBeGreaterThan(0);
    expect(await canConnect(first)).toBe(false);
  });

  it('fails readiness immediately when the preview child exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(23)']);
    await expect(waitForServerOrExit(child, 'http://127.0.0.1:1/', { timeoutMs: 5_000 }))
      .rejects.toThrow(/exited.*23/i);
  });

  it('terminates a detached preview process tree and releases its listener', async () => {
    const port = await allocateLoopbackPort();
    const program = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
        require('node:http').createServer((_, res) => res.end('ok')).listen(${port}, '127.0.0.1');
        setInterval(() => {}, 1000);
      `)}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;
    const preview = spawn(process.execPath, ['-e', program], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    try {
      await waitForServerOrExit(preview, `http://127.0.0.1:${port}/`, { timeoutMs: 5_000 });
      expect(await canConnect(port)).toBe(true);
    } finally {
      await stopProcessTree(preview, { graceMs: 1_000, killMs: 1_000 });
    }
    await expect.poll(() => canConnect(port), { timeout: 3_000 }).toBe(false);
  });
});
