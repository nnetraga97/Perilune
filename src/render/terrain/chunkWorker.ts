/// <reference lib="webworker" />
import {
  buildTerrainChunkGeometry,
  terrainGeometryTransferables,
  type TerrainChunkGeometryRequest,
} from './chunkGeometry';

declare const self: DedicatedWorkerGlobalScope;

export type TerrainWorkerPostMessage = (
  result: ReturnType<typeof buildTerrainChunkGeometry>,
  transfer: ArrayBuffer[],
) => void;

export function handleTerrainChunkWorkerRequest(
  request: TerrainChunkGeometryRequest,
  postMessage: TerrainWorkerPostMessage,
): void {
  const result = buildTerrainChunkGeometry(request);
  postMessage(result, terrainGeometryTransferables(result));
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = (event: MessageEvent<TerrainChunkGeometryRequest>): void => {
    handleTerrainChunkWorkerRequest(event.data, (result, transfer) => self.postMessage(result, transfer));
  };
}
