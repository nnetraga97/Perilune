/**
 * Pinned NOAA VDatum 4.8 NAVD88 -> EGM2008 correction surface for the bounded
 * KSC 3DEP coverage. Values are target EGM2008 height for a zero-metre NAVD88
 * input. Runtime height is therefore `navd88 + correction`.
 *
 * This is deliberately a spatial grid rather than a constant offset. Visual
 * delivery uses it in Milestone 2; Milestone 3 also applies the same pinned
 * correction before a bounded KSC raster can become frozen contact authority.
 */
export const KSC_NAVD88_TO_EGM2008 = Object.freeze({
  source: 'NOAA VDatum 4.8 Full API',
  sourceHorizontalFrame: 'NAD83_2011',
  targetHorizontalFrame: 'WGS84_G1674',
  sourceVerticalFrame: 'NAVD88/GEOID18',
  targetVerticalFrame: 'EGM2008/EGM2008',
  coverage: Object.freeze([-80.75, 28.5, -80.5, 28.75] as const),
  width: 3,
  height: 3,
  uncertaintyMeters: 0.16,
  correctionsMeters: Object.freeze([
    -0.030, -0.053, -0.067,
    -0.047, -0.070, -0.081,
    -0.059, -0.072, -0.079,
  ]),
});

export function kscNavd88ToEgm2008Correction(longitudeDegrees: number, latitudeDegrees: number): number {
  const grid = KSC_NAVD88_TO_EGM2008;
  const [west, south, east, north] = grid.coverage;
  if (longitudeDegrees < west || longitudeDegrees > east || latitudeDegrees < south || latitudeDegrees > north) {
    throw new RangeError('KSC datum conversion requested outside its pinned coverage');
  }
  const x = (longitudeDegrees - west) / (east - west) * (grid.width - 1);
  const y = (latitudeDegrees - south) / (north - south) * (grid.height - 1);
  const x0 = Math.min(grid.width - 1, Math.floor(x));
  const y0 = Math.min(grid.height - 1, Math.floor(y));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number): number => grid.correctionsMeters[iy * grid.width + ix];
  const southValue = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
  const northValue = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
  return southValue + (northValue - southValue) * fy;
}
