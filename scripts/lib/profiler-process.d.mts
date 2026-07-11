import type { ChildProcess } from 'node:child_process';

export interface ProcessCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export function terminateWindowsProcessTree(
  pid: number,
  executor?: (command: ProcessCommand) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<void>;

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
