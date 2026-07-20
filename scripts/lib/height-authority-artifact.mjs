import { createHash } from 'node:crypto';

function rounded(value, places) {
  return Number(value.toFixed(places));
}

export function checkedHeightGridFromEntry(entry) {
  return {
    bodyId: entry.bodyId,
    sourceId: entry.sourceId,
    sourcePath: entry.sourcePath,
    sourceSha256: entry.sourceSha256,
    sourceDimensions: [...entry.sourceDimensions],
    verticalDatum: entry.verticalDatum,
    derivationKernel: entry.derivationKernel,
    width: entry.width,
    height: entry.height,
    minimumHeightMeters: rounded(entry.minimum, 6),
    maximumHeightMeters: rounded(entry.maximum, 6),
    noDataCount: entry.noDataCount,
    quantizationScaleMeters: entry.quantizationScaleMeters,
    quantizationOffsetMeters: entry.quantizationOffsetMeters,
    worstQuantizationErrorMeters: rounded(entry.worstQuantizationErrorMeters, 9),
    rmsQuantizationErrorMeters: rounded(entry.rmsQuantizationErrorMeters, 9),
    encodedInt16Base64: entry.data,
  };
}

export function checkedHeightArtifactDigest(grids) {
  return createHash('sha256').update(JSON.stringify(grids)).digest('hex');
}
