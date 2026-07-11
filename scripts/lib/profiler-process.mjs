import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

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

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

function executeCommand(command) {
  return new Promise((resolve, reject) => {
    const process = spawn(command.file, command.args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    process.once('error', reject);
    process.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export async function terminateWindowsProcessTree(pid, executor = executeCommand) {
  const command = Object.freeze({
    file: 'taskkill',
    args: Object.freeze(['/PID', String(pid), '/T', '/F']),
  });
  const result = await executor(command);
  if (result.code !== 0) {
    throw new Error(`taskkill failed for preview process tree ${pid} with exit code ${result.code}`);
  }
}

function waitForDirectChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function stopProcessTree(child, options = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child.pid);
    if (!await waitForDirectChildExit(child, options.killMs ?? 2_000)) {
      throw new Error(`Preview process ${child.pid} did not exit after taskkill`);
    }
    return;
  }
  const processGroupId = child.pid;
  signalProcessGroup(processGroupId, 'SIGTERM');
  if (await waitForProcessGroupExit(processGroupId, options.graceMs ?? 3_000)) return;
  signalProcessGroup(processGroupId, 'SIGKILL');
  if (!await waitForProcessGroupExit(processGroupId, options.killMs ?? 2_000)) {
    throw new Error(`Preview process group ${processGroupId} did not exit after SIGKILL`);
  }
}
