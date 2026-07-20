/// <reference lib="webworker" />
import {
  reprojectEquirectAtlasToCubePage,
  reprojectHeightAtlasToCubeNormalPage,
  type EquirectAtlasPixels,
  type NumericHeightAtlas,
} from './cubePageReprojector';
import type { TerrainTileId } from '../terrain/tile';

export interface DetailWorkerRequest {
  readonly generation: number;
  readonly atlas: EquirectAtlasPixels;
  readonly pages: readonly Readonly<{
    readonly tile: TerrainTileId;
    readonly heightAtlas?: NumericHeightAtlas;
  }>[];
  readonly bodyRadius: number;
  readonly pageSize: number;
  readonly gutter: number;
}

export interface DetailWorkerPageResponse {
  readonly tile: TerrainTileId;
  readonly pixels: Uint8ClampedArray;
  readonly normalPixels?: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly pageSize: number;
  readonly gutter: number;
  readonly sourceCellMeters?: number;
  readonly minimumHeightMeters?: number;
  readonly maximumHeightMeters?: number;
  readonly normalValidFraction?: number;
}

export interface DetailWorkerResponse {
  readonly generation: number;
  readonly pages: readonly DetailWorkerPageResponse[];
}

export function handleDetailWorkerRequest(request: Readonly<DetailWorkerRequest>): DetailWorkerResponse {
  const pages = request.pages.map(({ tile, heightAtlas }) => {
    const page = reprojectEquirectAtlasToCubePage(request.atlas, tile, request.pageSize, request.gutter);
    const normal = heightAtlas
      ? reprojectHeightAtlasToCubeNormalPage(heightAtlas, tile, request.bodyRadius, request.pageSize, request.gutter)
      : null;
    return Object.freeze({
      tile,
      ...page,
      normalPixels: normal?.pixels,
      sourceCellMeters: normal?.sourceCellMeters,
      minimumHeightMeters: normal?.minimumHeightMeters,
      maximumHeightMeters: normal?.maximumHeightMeters,
      normalValidFraction: normal?.validFraction,
    });
  });
  return Object.freeze({ generation: request.generation, pages: Object.freeze(pages) });
}

declare const self: DedicatedWorkerGlobalScope;
if (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (event: MessageEvent<DetailWorkerRequest>): void => {
    const result = handleDetailWorkerRequest(event.data);
    const transfers: Transferable[] = [];
    for (const page of result.pages) {
      transfers.push(page.pixels.buffer);
      if (page.normalPixels) transfers.push(page.normalPixels.buffer);
    }
    self.postMessage(result, transfers);
  };
}
