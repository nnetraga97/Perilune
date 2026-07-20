import { readFile } from 'node:fs/promises';

export const SURFACE_CLASS = Object.freeze({
  UNKNOWN: 0,
  LAND: 1,
  OPEN_OCEAN: 2,
  ESTUARINE_DEEPWATER: 3,
  INTERTIDAL: 4,
  INLAND_WATER: 5,
  WETLAND: 6,
});

export const GLOBAL_SURFACE_CLASS_BOUNDS = Object.freeze([-180, -90, 180, 90]);
export const KSC_SURFACE_CLASS_BOUNDS = Object.freeze([-80.8, 28.45, -80.2, 28.75]);
// 15 m-class sampling over the locked page, still below the 8 MiB R8 cap.
export const KSC_SURFACE_CLASS_DIMENSIONS = Object.freeze([3840, 2160]);

export function classifyNwiAttribute(attribute) {
  const value = String(attribute ?? '').trim().toUpperCase();
  if (value.startsWith('E1')) return SURFACE_CLASS.ESTUARINE_DEEPWATER;
  if (value.startsWith('M1')) return SURFACE_CLASS.OPEN_OCEAN;
  if (value.startsWith('E2') || value.startsWith('M2')) return SURFACE_CLASS.INTERTIDAL;
  if (value.startsWith('R') || value.startsWith('L') || value.startsWith('PUB') || value.startsWith('PAB')) {
    return SURFACE_CLASS.INLAND_WATER;
  }
  if (value.startsWith('P')) return SURFACE_CLASS.WETLAND;
  return SURFACE_CLASS.UNKNOWN;
}

function target(width, height, bounds, initialClass) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Surface-class raster dimensions must be positive integers');
  }
  const [xmin, ymin, xmax, ymax] = bounds;
  if (!(xmin < xmax && ymin < ymax)) throw new Error('Surface-class bounds are invalid');
  const pixels = new Uint8Array(width * height);
  pixels.fill(initialClass);
  return { width, height, bounds: [xmin, ymin, xmax, ymax], pixels };
}

function pixelX(longitude, raster) {
  const [xmin, , xmax] = raster.bounds;
  return (longitude - xmin) / (xmax - xmin) * raster.width - 0.5;
}

function pixelY(latitude, raster) {
  const [, ymin, , ymax] = raster.bounds;
  return (ymax - latitude) / (ymax - ymin) * raster.height - 0.5;
}

function appendRingIntersections(rows, yMin, raster, pointCount, pointAt) {
  if (pointCount < 3) return;
  let previous = pointAt(pointCount - 1);
  for (let index = 0; index < pointCount; index++) {
    const current = pointAt(index);
    if (current[1] !== previous[1]) {
      const lowLatitude = Math.min(previous[1], current[1]);
      const highLatitude = Math.max(previous[1], current[1]);
      const firstRow = Math.max(yMin, Math.ceil(pixelY(highLatitude, raster)));
      const lastRow = Math.min(yMin + rows.length - 1, Math.ceil(pixelY(lowLatitude, raster)) - 1);
      for (let y = firstRow; y <= lastRow; y++) {
        const [, rasterYMin, , rasterYMax] = raster.bounds;
        const latitude = rasterYMax - (y + 0.5) / raster.height * (rasterYMax - rasterYMin);
        const t = (latitude - previous[1]) / (current[1] - previous[1]);
        const longitude = previous[0] + (current[0] - previous[0]) * t;
        rows[y - yMin].push(pixelX(longitude, raster));
      }
    }
    previous = current;
  }
}

function fillRings(raster, rings, code, bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const xLo = Math.max(0, Math.ceil(pixelX(xmin, raster)));
  const xHi = Math.min(raster.width - 1, Math.floor(pixelX(xmax, raster)));
  const yLo = Math.max(0, Math.ceil(pixelY(ymax, raster)));
  const yHi = Math.min(raster.height - 1, Math.floor(pixelY(ymin, raster)));
  if (xLo > xHi || yLo > yHi) return;
  const rows = Array.from({ length: yHi - yLo + 1 }, () => []);
  for (const ring of rings) appendRingIntersections(rows, yLo, raster, ring.count, ring.pointAt);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const intersections = rows[rowIndex].sort((a, b) => a - b);
    const y = yLo + rowIndex;
    for (let index = 0; index + 1 < intersections.length; index += 2) {
      const start = Math.max(xLo, Math.ceil(intersections[index]));
      const end = Math.min(xHi, Math.ceil(intersections[index + 1]) - 1);
      if (start <= end) raster.pixels.fill(code, y * raster.width + start, y * raster.width + end + 1);
    }
  }
}

function shapefilePolygons(bytes, visit) {
  if (bytes.length < 100 || bytes.readInt32BE(0) !== 9994) throw new Error('Invalid ESRI shapefile header');
  let offset = 100;
  while (offset + 8 <= bytes.length) {
    const contentBytes = bytes.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    if (contentBytes < 4 || content + contentBytes > bytes.length) throw new Error('Truncated ESRI shapefile record');
    const shapeType = bytes.readInt32LE(content);
    if (shapeType === 5) {
      const bbox = [
        bytes.readDoubleLE(content + 4), bytes.readDoubleLE(content + 12),
        bytes.readDoubleLE(content + 20), bytes.readDoubleLE(content + 28),
      ];
      const partCount = bytes.readInt32LE(content + 36);
      const pointCount = bytes.readInt32LE(content + 40);
      const partsOffset = content + 44;
      const pointsOffset = partsOffset + partCount * 4;
      if (partCount < 1 || pointCount < 3 || pointsOffset + pointCount * 16 > content + contentBytes) {
        throw new Error('Invalid polygon record in ESRI shapefile');
      }
      visit({ bytes, bbox, partCount, pointCount, partsOffset, pointsOffset });
    } else if (shapeType !== 0) {
      throw new Error(`Unsupported ESRI shape type ${shapeType}`);
    }
    offset = content + contentBytes;
  }
}

function shapefileRings(record) {
  const rings = [];
  for (let part = 0; part < record.partCount; part++) {
    const start = record.bytes.readInt32LE(record.partsOffset + part * 4);
    const end = part + 1 < record.partCount
      ? record.bytes.readInt32LE(record.partsOffset + (part + 1) * 4)
      : record.pointCount;
    rings.push({
      count: end - start,
      pointAt: (index) => {
        const offset = record.pointsOffset + (start + index) * 16;
        return [record.bytes.readDoubleLE(offset), record.bytes.readDoubleLE(offset + 8)];
      },
    });
  }
  return rings;
}

export async function rasterizeGshhg(options) {
  const rasters = options.targets.map((entry) => target(
    entry.width, entry.height, entry.bounds ?? GLOBAL_SURFACE_CLASS_BOUNDS, SURFACE_CLASS.OPEN_OCEAN,
  ));
  const levels = [
    { level: 1, code: SURFACE_CLASS.LAND },
    { level: 2, code: SURFACE_CLASS.INLAND_WATER },
    { level: 3, code: SURFACE_CLASS.LAND },
    { level: 4, code: SURFACE_CLASS.INLAND_WATER },
    { level: 5, code: SURFACE_CLASS.LAND },
  ];
  for (const { level, code } of levels) {
    const filePath = options.levelPaths[level - 1];
    if (!filePath) throw new Error(`Missing GSHHG level ${level} path`);
    const bytes = await readFile(filePath);
    shapefilePolygons(bytes, (record) => {
      const rings = shapefileRings(record);
      for (const raster of rasters) fillRings(raster, rings, code, record.bbox);
    });
  }
  return rasters;
}

function geoJsonRings(geometry) {
  const polygons = geometry?.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.map((polygon) => polygon.map((coordinates) => ({
    count: coordinates.length,
    pointAt: (index) => coordinates[index],
  })));
}

function ringBounds(rings) {
  let xmin = Infinity; let ymin = Infinity; let xmax = -Infinity; let ymax = -Infinity;
  for (const ring of rings) {
    for (let index = 0; index < ring.count; index++) {
      const [x, y] = ring.pointAt(index);
      xmin = Math.min(xmin, x); ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x); ymax = Math.max(ymax, y);
    }
  }
  return [xmin, ymin, xmax, ymax];
}

export function overlayNwiGeoJson(raster, collection) {
  const features = [...(collection.features ?? [])].sort((left, right) =>
    Number(right.properties?.acres ?? 0) - Number(left.properties?.acres ?? 0)
    || Number(left.properties?.objectId ?? left.id ?? 0) - Number(right.properties?.objectId ?? right.id ?? 0));
  for (const feature of features) {
    const code = classifyNwiAttribute(feature.properties?.attribute);
    if (code === SURFACE_CLASS.UNKNOWN) continue;
    for (const rings of geoJsonRings(feature.geometry)) fillRings(raster, rings, code, ringBounds(rings));
  }
  return raster;
}

export function sampleSurfaceClassRaster(raster, longitudeDegrees, latitudeDegrees) {
  const x = Math.min(raster.width - 1, Math.max(0, Math.round(pixelX(longitudeDegrees, raster))));
  const y = Math.min(raster.height - 1, Math.max(0, Math.round(pixelY(latitudeDegrees, raster))));
  return raster.pixels[y * raster.width + x];
}
