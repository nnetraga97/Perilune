import type { PlanetDetailSourceAdapter } from './sourceAdapter';
import { WmtsAdapter } from './wmtsAdapter';
import { ArcGisImageAdapter } from './arcGisImageAdapter';

const gibsMatrices = [
  [2, 1], [3, 2], [5, 3], [10, 5], [20, 10], [40, 20], [80, 40], [160, 80],
] as const;
const moonMatrices = Array.from({ length: 9 }, (_, level) => ({ width: 2 ** (level + 1), height: 2 ** level }));

export const EARTH_GIBS_DETAIL = new WmtsAdapter({
  datasetId: 'nasa-gibs-bmng-500m-v1',
  bodyId: 'earth',
  generation: 'BlueMarble_NextGeneration-default-500m',
  tileSize: 512,
  matrices: gibsMatrices.map(([width, height]) => ({ width, height })),
  maximumBytes: 512 * 1024,
  urlFor: (level, row, column) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/${level}/${row}/${column}.jpeg`,
});

export const MOON_WAC_DETAIL = new WmtsAdapter({
  datasetId: 'nasa-moontrek-wac-303ppd-v02',
  bodyId: 'moon',
  generation: 'LRO_WAC_Mosaic_Global_303ppd_v02',
  tileSize: 256,
  matrices: moonMatrices,
  maximumBytes: 512 * 1024,
  urlFor: (level, row, column) =>
    `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${level}/${row}/${column}.jpg`,
});

export const EARTH_KSC_NAIP_DETAIL = new ArcGisImageAdapter({
  datasetId: 'usda-naip-ksc-2025-29992',
  bodyId: 'earth',
  generation: 'OBJECTID-29992',
  tileSize: 512,
  maxLevel: 18,
  maximumBytes: 512 * 1024,
  coverage: [-80.69, 28.56, -80.58, 28.69],
});

const sources = new Map<string, PlanetDetailSourceAdapter>([
  ['earth', EARTH_GIBS_DETAIL],
  ['moon', MOON_WAC_DETAIL],
]);

export function planetVisualDetailSource(bodyId: string): PlanetDetailSourceAdapter | null {
  return sources.get(bodyId) ?? null;
}

export function planetVisualDetailSourceForView(
  bodyId: string,
  direction: Readonly<{ x: number; y: number; z: number }>,
  metersPerPixel: number,
  excludedDatasetIds: ReadonlySet<string> = new Set(),
): PlanetDetailSourceAdapter | null {
  if (bodyId === 'earth' && metersPerPixel <= 10 && !excludedDatasetIds.has(EARTH_KSC_NAIP_DETAIL.datasetId)) {
    const magnitude = Math.hypot(direction.x, direction.y, direction.z);
    if (magnitude > 0) {
      const longitude = Math.atan2(direction.y, direction.x) * 180 / Math.PI;
      const latitude = Math.asin(Math.max(-1, Math.min(1, direction.z / magnitude))) * 180 / Math.PI;
      const [west, south, east, north] = EARTH_KSC_NAIP_DETAIL.coverage;
      if (longitude >= west && longitude <= east && latitude >= south && latitude <= north) return EARTH_KSC_NAIP_DETAIL;
    }
  }
  const fallback = planetVisualDetailSource(bodyId);
  return fallback && !excludedDatasetIds.has(fallback.datasetId) ? fallback : null;
}
