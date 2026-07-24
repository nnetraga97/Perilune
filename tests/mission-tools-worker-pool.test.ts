import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '../src/sim/state';
import type { TransferWorkerRequest, TransferWorkerResult } from '../src/sim/transferWorker';
import { MissionTools, type MissionToolCallbacks } from '../src/ui/missionTools';
import type { WindowDef, WindowManager } from '../src/ui/window';

class ManualWorker {
  static instances: ManualWorker[] = [];

  onmessage: ((event: MessageEvent<TransferWorkerResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: TransferWorkerRequest[] = [];
  terminated = false;

  constructor() {
    ManualWorker.instances.push(this);
  }

  postMessage(request: TransferWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  finish(result: TransferWorkerResult): void {
    this.onmessage?.({ data: result } as MessageEvent<TransferWorkerResult>);
  }
}

interface MissionToolsHarness {
  queueTransferVerification(
    game: GameState,
    fromId: string,
    targets: readonly string[],
    options: TransferWorkerRequest['options'],
  ): void;
  transferPendingTargets: Set<string>;
}

function createSubject(): MissionTools {
  const windows = {
    register(_definition: WindowDef): void {},
    close(_id: string): void {},
  } as unknown as WindowManager;
  const callbacks: MissionToolCallbacks = {
    onSwitchVessel() {},
    onSketchNode() {},
    onSetTarget() {},
    onOrbitTarget() {},
    onFocusBody() {},
    onRenameVessel() {},
    onTerminateVessel() {},
    onRecoverVessel() {},
  };
  return new MissionTools(windows, () => ({}) as GameState, callbacks, {} as HTMLElement);
}

function gameAt(time: number): GameState {
  const bodies = new Map([
    ['earth', { def: { id: 'earth' } }],
    ['mars', { def: { id: 'mars' } }],
    ['jupiter', { def: { id: 'jupiter' } }],
    ['callisto', { def: { id: 'callisto' } }],
  ]);
  return {
    time,
    universe: { bodies, homeBodyId: 'earth' },
  } as unknown as GameState;
}

function resultOf(request: TransferWorkerRequest): TransferWorkerResult {
  return {
    requestId: request.requestId,
    targetId: request.targetId,
    plan: null,
    elapsedMs: 1,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  ManualWorker.instances = [];
});

describe('MissionTools transfer worker pool', () => {
  it('reuses workers and drops queued stale targets when time-warp requests supersede a batch', () => {
    vi.stubGlobal('Worker', ManualWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 3 });
    vi.stubGlobal('window', { innerWidth: 1280 });
    const subject = createSubject();
    const harness = subject as unknown as MissionToolsHarness;

    harness.queueTransferVerification(gameAt(0), 'earth', ['mars', 'jupiter', 'callisto'], { parkRadius: 7_000_000 });

    expect(ManualWorker.instances).toHaveLength(2);
    const [first, second] = ManualWorker.instances;
    expect(first.posted.map((request) => request.targetId)).toEqual(['mars']);
    expect(second.posted.map((request) => request.targetId)).toEqual(['jupiter']);

    harness.queueTransferVerification(gameAt(300), 'earth', ['jupiter', 'callisto'], { parkRadius: 7_000_000 });

    expect(ManualWorker.instances).toHaveLength(2);
    expect(first.terminated).toBe(false);
    expect(second.terminated).toBe(false);

    first.finish(resultOf(first.posted[0]));
    second.finish(resultOf(second.posted[0]));

    expect(first.posted.map((request) => request.targetId)).toEqual(['mars', 'jupiter']);
    expect(second.posted.map((request) => request.targetId)).toEqual(['jupiter', 'callisto']);
    expect(first.posted.some((request) => request.targetId === 'callisto' && request.requestId === 1)).toBe(false);
    expect(harness.transferPendingTargets).toEqual(new Set(['jupiter', 'callisto']));

    first.finish(resultOf(first.posted[1]));
    second.finish(resultOf(second.posted[1]));

    expect(harness.transferPendingTargets.size).toBe(0);
    expect(ManualWorker.instances).toHaveLength(2);
  });

  it('terminates the persistent pool only during explicit disposal', () => {
    vi.stubGlobal('Worker', ManualWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 3 });
    vi.stubGlobal('window', { innerWidth: 1280 });
    const subject = createSubject();
    const harness = subject as unknown as MissionToolsHarness;

    harness.queueTransferVerification(gameAt(0), 'earth', ['mars'], { parkRadius: 7_000_000 });
    subject.dispose();
    subject.dispose();

    expect(ManualWorker.instances).toHaveLength(2);
    expect(ManualWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(harness.transferPendingTargets.size).toBe(0);
  });
});
