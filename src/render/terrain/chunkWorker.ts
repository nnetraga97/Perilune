/// <reference lib="webworker" />
import {
  buildTerrainChunkGeometry,
  terrainGeometryTransferables,
  type TerrainChunkGeometryRequest,
} from './chunkGeometry';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<TerrainChunkGeometryRequest>): void => {
  const result = buildTerrainChunkGeometry(event.data);
  self.postMessage(result, terrainGeometryTransferables(result));
};
