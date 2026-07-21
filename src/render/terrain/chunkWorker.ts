/// <reference lib="webworker" />
import {
  buildTerrainChunkGeometry,
  terrainGeometryTransferables,
  type TerrainChunkGeometryRequest,
} from './chunkGeometry';
import type { BodyFeatureRecipe } from '../../sim/terrainRecipe';

declare const self: DedicatedWorkerGlobalScope;

export type TerrainWorkerPostMessage = (
  result: ReturnType<typeof buildTerrainChunkGeometry>,
  transfer: ArrayBuffer[],
) => void;

export type TerrainWorkerRequest =
  | TerrainChunkGeometryRequest
  | Readonly<{ kind: 'configure-authority'; generation: number; recipe: BodyFeatureRecipe }>
  | Readonly<{ kind: 'build'; request: TerrainChunkGeometryRequest }>;

const authorityRecipes = new Map<number, BodyFeatureRecipe>();

function resolveAuthorityRecipe(request: TerrainChunkGeometryRequest): TerrainChunkGeometryRequest {
  const region = request.recipe.sourceHeightRegion;
  if (!region || region.samples) return request;
  const configured = authorityRecipes.get(request.generation);
  if (
    !configured
    || configured.hash !== request.recipe.hash
    || configured.authorityGeneration !== request.recipe.authorityGeneration
    || configured.sourceHeightRegion?.digest !== region.digest
  ) {
    throw new Error(`Terrain worker authority ${request.generation} is not configured`);
  }
  return Object.freeze({ ...request, recipe: configured });
}

export function handleTerrainChunkWorkerRequest(
  request: TerrainChunkGeometryRequest,
  postMessage: TerrainWorkerPostMessage,
): void {
  const result = buildTerrainChunkGeometry(request);
  postMessage(result, terrainGeometryTransferables(result));
}

export function handleTerrainWorkerMessage(
  message: TerrainWorkerRequest,
  postMessage: TerrainWorkerPostMessage,
): void {
  if ('kind' in message && message.kind === 'configure-authority') {
    const region = message.recipe.sourceHeightRegion;
    if (
      message.recipe.terrainGeneration !== message.generation
      || !region?.samples
      || region.samples.length !== region.width * region.height
    ) {
      throw new Error(`Invalid terrain worker authority ${message.generation}`);
    }
    authorityRecipes.set(message.generation, message.recipe);
    return;
  }
  const request = 'kind' in message ? message.request : message;
  handleTerrainChunkWorkerRequest(resolveAuthorityRecipe(request), postMessage);
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = (event: MessageEvent<TerrainWorkerRequest>): void => {
    handleTerrainWorkerMessage(event.data, (result, transfer) => self.postMessage(result, transfer));
  };
}
