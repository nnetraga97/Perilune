import { createServer } from 'node:net';

export function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a loopback port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export async function waitForServerOrExit(child, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const childExit = exited(child).then(({ code, signal }) => {
    throw new Error(`Preview exited before readiness (code ${code}, signal ${signal})`);
  });
  const readiness = (async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {
        // The listener is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for preview at ${url}`);
  })();
  return Promise.race([readiness, childExit]);
}

function signalTree(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitBounded(child, timeoutMs) {
  return Promise.race([
    exited(child).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function stopProcessTree(child, options = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, 'SIGTERM');
  if (await waitBounded(child, options.graceMs ?? 3_000)) return;
  signalTree(child, 'SIGKILL');
  if (!await waitBounded(child, options.killMs ?? 2_000)) {
    throw new Error(`Preview process tree ${child.pid} did not exit after SIGKILL`);
  }
}
