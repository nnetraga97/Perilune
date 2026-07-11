import type { ChildProcess } from 'node:child_process';

export function allocateLoopbackPort(): Promise<number>;
export function waitForServerOrExit(
  child: ChildProcess,
  url: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void>;
export function stopProcessTree(
  child: ChildProcess,
  options?: { graceMs?: number; killMs?: number },
): Promise<void>;
