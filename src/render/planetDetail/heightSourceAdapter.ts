import type { DetailTileAddress } from './sourceAdapter';

export interface HeightImageAddress extends DetailTileAddress {
  readonly datasetId: string;
  readonly width: number;
  readonly height: number;
  readonly verticalDatum: string;
  readonly engineDatum: string;
  readonly bounds: readonly [number, number, number, number];
}

interface HeightSourceOptions {
  readonly datasetId: string;
  readonly bodyId: 'earth' | 'moon';
  readonly generation: string;
  readonly endpoint: string;
  readonly verticalDatum: string;
  readonly engineDatum: string;
  readonly maximumBytes: number;
  readonly mosaicRasterId?: number;
  readonly spatialReference: string;
  readonly coverage: readonly [number, number, number, number];
}

export class HeightSourceAdapter {
  readonly datasetId;
  readonly bodyId;
  readonly generation;
  readonly verticalDatum;
  readonly engineDatum;
  readonly coverage;
  readonly maximumBytes;

  constructor(private readonly options: Readonly<HeightSourceOptions>) {
    this.datasetId = options.datasetId;
    this.bodyId = options.bodyId;
    this.generation = options.generation;
    this.verticalDatum = options.verticalDatum;
    this.engineDatum = options.engineDatum;
    this.coverage = options.coverage;
    this.maximumBytes = options.maximumBytes;
  }
  request(bounds: readonly [number, number, number, number], width: number, height: number): HeightImageAddress {
    if (!bounds.every(Number.isFinite) || !(bounds[0] < bounds[2]) || !(bounds[1] < bounds[3])) throw new Error('Invalid height bounds');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 512 || height > 512) throw new Error('Invalid height response size');
    const url = new URL(this.options.endpoint);
    url.searchParams.set('bbox', bounds.join(','));
    url.searchParams.set('bboxSR', this.options.spatialReference);
    url.searchParams.set('imageSR', this.options.spatialReference);
    url.searchParams.set('size', `${width},${height}`);
    url.searchParams.set('format', 'tiff');
    url.searchParams.set('pixelType', 'F32');
    url.searchParams.set('interpolation', 'RSP_BilinearInterpolation');
    if (this.options.mosaicRasterId !== undefined) {
      url.searchParams.set('mosaicRule', JSON.stringify({ mosaicMethod: 'esriMosaicLockRaster', lockRasterIds: [this.options.mosaicRasterId] }));
    }
    url.searchParams.set('f', 'image');
    const boundsKey = bounds.map((value) => value.toFixed(8)).join(',');
    return Object.freeze({
      datasetId: this.options.datasetId,
      level: 0,
      row: 0,
      column: 0,
      matrixWidth: 1,
      matrixHeight: 1,
      tileSize: Math.max(width, height),
      url: url.toString(),
      cacheKey: `${this.options.generation}/${boundsKey}/${width}x${height}`,
      maximumBytes: this.options.maximumBytes,
      expectedMimeTypes: Object.freeze(['image/tiff']),
      coverage: this.options.coverage,
      width,
      height,
      verticalDatum: this.options.verticalDatum,
      engineDatum: this.options.engineDatum,
      bounds: Object.freeze([...bounds]) as unknown as readonly [number, number, number, number],
    });
  }
}

export const KSC_3DEP_HEIGHT = new HeightSourceAdapter({
  datasetId: 'usgs-3dep-ksc-1m-86037',
  bodyId: 'earth',
  generation: 'OBJECTID-86037-vdatum48-grid-20260720',
  endpoint: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage',
  verticalDatum: 'NAVD88/GEOID18',
  engineDatum: 'EGM2008 orthometric presentation height',
  maximumBytes: 2 * 1024 * 1024,
  mosaicRasterId: 86037,
  spatialReference: '4326',
  coverage: [-80.75, 28.50, -80.50, 28.75],
});

export const MOON_LOLA_HEIGHT = new HeightSourceAdapter({
  datasetId: 'nasa-moontrek-lola-global-128ppd-v04',
  bodyId: 'moon',
  generation: 'LRO_LOLA_DEM_Global_128ppd_v04',
  endpoint: 'https://trek.nasa.gov/moon/trekarcgis/rest/services/LRO_LOLA_DEM_Global_128ppd_v04/ImageServer/exportImage',
  verticalDatum: '1737400 m Moon reference sphere',
  engineDatum: '1737400 m Moon reference sphere',
  maximumBytes: 2 * 1024 * 1024,
  spatialReference: '104903',
  coverage: [-180, -90, 180, 90],
});

export function planetHeightDetailSource(bodyId: string): HeightSourceAdapter | null {
  if (bodyId === 'earth') return KSC_3DEP_HEIGHT;
  if (bodyId === 'moon') return MOON_LOLA_HEIGHT;
  return null;
}
