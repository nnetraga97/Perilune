export const SURFACE_CLASS: Readonly<{
  UNKNOWN: 0; LAND: 1; OPEN_OCEAN: 2; ESTUARINE_DEEPWATER: 3;
  INTERTIDAL: 4; INLAND_WATER: 5; WETLAND: 6;
}>;
export const GLOBAL_SURFACE_CLASS_BOUNDS: readonly [number, number, number, number];
export const KSC_SURFACE_CLASS_BOUNDS: readonly [number, number, number, number];
export const KSC_SURFACE_CLASS_DIMENSIONS: readonly [number, number];
export interface SurfaceClassRaster {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  pixels: Uint8Array;
}
export function classifyNwiAttribute(attribute: unknown): number;
export function rasterizeGshhg(options: {
  levelPaths: readonly string[];
  targets: readonly { width: number; height: number; bounds?: readonly [number, number, number, number] }[];
}): Promise<SurfaceClassRaster[]>;
export function overlayNwiGeoJson(raster: SurfaceClassRaster, collection: any): SurfaceClassRaster;
export function sampleSurfaceClassRaster(raster: SurfaceClassRaster, longitudeDegrees: number, latitudeDegrees: number): number;
