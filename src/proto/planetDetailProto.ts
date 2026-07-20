import { reprojectEquirectAtlasToCubePage } from '../render/planetDetail/cubePageReprojector';
import { planetDetailBudget } from '../render/planetDetail/detailBudget';
import { selectEquirectPages } from '../render/planetDetail/equirectPageTable';
import { EARTH_GIBS_DETAIL, EARTH_KSC_NAIP_DETAIL, MOON_WAC_DETAIL } from '../render/planetDetail/sourceRegistry';
import { createTerrainTileId } from '../render/terrain/tile';
import { KSC_3DEP_HEIGHT, MOON_LOLA_HEIGHT } from '../render/planetDetail/heightSourceAdapter';

export interface PlanetDetailPrototypeSnapshot {
  readonly sources: readonly Readonly<{ datasetId: string; direct: boolean; address: string }>[];
  readonly selections: readonly Readonly<{ datasetId: string; signature: string }>[];
  readonly budgets: Readonly<{ mediumGpuBytes: number; highGpuBytes: number; mediumRequests: number; highRequests: number }>;
  readonly cubePage: Readonly<{ width: number; height: number; gutter: number; checksum: number }>;
  readonly fallback: 'resident-parent';
  readonly numericSources: readonly Readonly<{ datasetId: string; verticalDatum: string; url: string }>[];
}

function syntheticAtlas() {
  const width = 360;
  const height = 180;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = x & 255;
    pixels[offset + 1] = y & 255;
    pixels[offset + 2] = (x ^ y) & 255;
    pixels[offset + 3] = 255;
  }
  return { pixels, width, height, matrixWidth: 1, matrixHeight: 1, startColumn: 0, startRow: 0, gridWidth: 1, gridHeight: 1 };
}

export function planetDetailPrototypeSnapshot(): PlanetDetailPrototypeSnapshot {
  const earthDirection = { x: 1, y: 0, z: 0 };
  const moonDirection = { x: 0.8, y: 0.4, z: -0.2 };
  const earthSelection = selectEquirectPages(EARTH_GIBS_DETAIL, 7, earthDirection)!;
  const moonSelection = selectEquirectPages(MOON_WAC_DETAIL, 8, moonDirection)!;
  const cube = reprojectEquirectAtlasToCubePage(syntheticAtlas(), createTerrainTileId(0, 2, 1, 2), 64, 2);
  let checksum = 0;
  for (const byte of cube.pixels) checksum = (checksum * 31 + byte) >>> 0;
  const medium = planetDetailBudget('medium');
  const high = planetDetailBudget('high');
  return Object.freeze({
    sources: Object.freeze([
      Object.freeze({ datasetId: EARTH_GIBS_DETAIL.datasetId, direct: true, address: EARTH_GIBS_DETAIL.address(7, earthSelection.centerRow, earthSelection.centerColumn).url }),
      Object.freeze({ datasetId: MOON_WAC_DETAIL.datasetId, direct: true, address: MOON_WAC_DETAIL.address(8, moonSelection.centerRow, moonSelection.centerColumn).url }),
      Object.freeze({ datasetId: EARTH_KSC_NAIP_DETAIL.datasetId, direct: false, address: EARTH_KSC_NAIP_DETAIL.address(18, 89381, 144731).url }),
    ]),
    selections: Object.freeze([
      Object.freeze({ datasetId: EARTH_GIBS_DETAIL.datasetId, signature: earthSelection.signature }),
      Object.freeze({ datasetId: MOON_WAC_DETAIL.datasetId, signature: moonSelection.signature }),
    ]),
    budgets: Object.freeze({
      mediumGpuBytes: medium.gpuBytes,
      highGpuBytes: high.gpuBytes,
      mediumRequests: medium.maximumProxyRequestsPerSession,
      highRequests: high.maximumProxyRequestsPerSession,
    }),
    cubePage: Object.freeze({ width: cube.width, height: cube.height, gutter: cube.gutter, checksum }),
    numericSources: Object.freeze([
      KSC_3DEP_HEIGHT.request([-80.621, 28.6271, -80.6208, 28.6273], 258, 258),
      MOON_LOLA_HEIGHT.request([-0.03125, -0.03125, 0.03125, 0.03125], 258, 258),
    ].map((source) => Object.freeze({ datasetId: source.datasetId, verticalDatum: source.verticalDatum, url: source.url }))),
    fallback: 'resident-parent',
  });
}

export async function runPlanetDetailProto(): Promise<void> {
  const snapshot = planetDetailPrototypeSnapshot();
  (window as unknown as { __PLANET_DETAIL_PROTO__: PlanetDetailPrototypeSnapshot }).__PLANET_DETAIL_PROTO__ = snapshot;
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  const output = document.createElement('pre');
  output.id = 'planet-detail-prototype';
  output.textContent = JSON.stringify(snapshot, null, 2);
  output.style.cssText = 'margin:24px;color:#d7e8f5;background:#07111c;padding:20px;white-space:pre-wrap;font:13px/1.5 monospace';
  document.body.append(output);
}
