/// <reference lib="webworker" />
import { Vec3 } from '../core/vec3';
import { planTransfer, type TransferOptions, type TransferPlan } from './transfer';
import { Universe, type BodyDef } from './universe';

declare const self: DedicatedWorkerGlobalScope;

interface SerializedVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TransferWorkerRequest {
  readonly requestId: number;
  readonly universe: readonly BodyDef[];
  readonly homeBodyId: string;
  readonly time: number;
  readonly fromId: string;
  readonly targetId: string;
  readonly options: Omit<TransferOptions, 'vesselPosition' | 'vesselVelocity'> & {
    readonly vesselPosition?: SerializedVec3;
    readonly vesselVelocity?: SerializedVec3;
  };
}

export interface TransferWorkerResult {
  readonly requestId: number;
  readonly targetId: string;
  readonly plan: TransferPlan | null;
  readonly elapsedMs: number;
  readonly error?: string;
}

/** Rebuild the immutable orbital model inside the worker and solve one target. */
export function calculateTransferWorkerRequest(
  request: TransferWorkerRequest,
  now: () => number = () => performance.now(),
): TransferWorkerResult {
  const startedAt = now();
  try {
    const universe = new Universe([...request.universe], request.homeBodyId);
    const from = universe.get(request.fromId);
    const target = universe.get(request.targetId);
    const position = request.options.vesselPosition;
    const velocity = request.options.vesselVelocity;
    const options: TransferOptions = {
      ...request.options,
      vesselPosition: position ? new Vec3(position.x, position.y, position.z) : undefined,
      vesselVelocity: velocity ? new Vec3(velocity.x, velocity.y, velocity.z) : undefined,
    };
    return {
      requestId: request.requestId,
      targetId: request.targetId,
      plan: planTransfer(universe, request.time, from, target, options),
      elapsedMs: now() - startedAt,
    };
  } catch (cause) {
    return {
      requestId: request.requestId,
      targetId: request.targetId,
      plan: null,
      elapsedMs: now() - startedAt,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

if (
  typeof self !== 'undefined'
  && typeof WorkerGlobalScope !== 'undefined'
  && self instanceof WorkerGlobalScope
) {
  self.onmessage = (event: MessageEvent<TransferWorkerRequest>): void => {
    self.postMessage(calculateTransferWorkerRequest(event.data));
  };
}
