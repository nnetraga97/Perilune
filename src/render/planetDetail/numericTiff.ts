export interface Float32Tiff {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
}

const TYPE_BYTES: Readonly<Record<number, number>> = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 });

export function decodeFloat32Tiff(buffer: ArrayBuffer, maximumPixels = 16 * 1024 * 1024): Float32Tiff {
  const view = new DataView(buffer);
  if (view.byteLength < 8) throw new Error('TIFF header is truncated');
  const marker = String.fromCharCode(view.getUint8(0), view.getUint8(1));
  if (marker !== 'II' && marker !== 'MM') throw new Error('TIFF byte order is invalid');
  const little = marker === 'II';
  if (view.getUint16(2, little) !== 42) throw new Error('Unsupported TIFF signature');
  const ifdOffset = view.getUint32(4, little);
  if (ifdOffset + 2 > view.byteLength) throw new Error('TIFF IFD is outside the response');
  const entries = view.getUint16(ifdOffset, little);
  if (ifdOffset + 2 + entries * 12 > view.byteLength) throw new Error('TIFF IFD is truncated');
  const tags = new Map<number, number[]>();
  for (let index = 0; index < entries; index++) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(offset, little);
    const type = view.getUint16(offset + 2, little);
    const count = view.getUint32(offset + 4, little);
    const typeBytes = TYPE_BYTES[type];
    if (!typeBytes || count > 16 * 1024 * 1024) continue;
    const bytes = count * typeBytes;
    const valueOffset = bytes <= 4 ? offset + 8 : view.getUint32(offset + 8, little);
    if (valueOffset + bytes > view.byteLength) throw new Error(`TIFF tag ${tag} points outside the response`);
    const values: number[] = [];
    for (let item = 0; item < count; item++) {
      const position = valueOffset + item * typeBytes;
      if (type === 1 || type === 2) values.push(view.getUint8(position));
      else if (type === 3) values.push(view.getUint16(position, little));
      else if (type === 4) values.push(view.getUint32(position, little));
      else if (type === 11) values.push(view.getFloat32(position, little));
      else if (type === 12) values.push(view.getFloat64(position, little));
    }
    tags.set(tag, values);
  }
  const scalar = (tag: number, fallback?: number): number => {
    const value = tags.get(tag)?.[0] ?? fallback;
    if (value === undefined) throw new Error(`TIFF is missing required tag ${tag}`);
    return value;
  };
  const width = scalar(256);
  const height = scalar(257);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > maximumPixels) {
    throw new Error('TIFF dimensions exceed the decode budget');
  }
  if (scalar(258) !== 32 || scalar(259, 1) !== 1 || scalar(277, 1) !== 1 || scalar(339, 1) !== 3) {
    throw new Error('TIFF must be uncompressed, single-channel IEEE Float32');
  }
  const values = new Float32Array(width * height);
  const tileOffsets = tags.get(324);
  const tileByteCounts = tags.get(325);
  if (tileOffsets && tileByteCounts) {
    const tileWidth = scalar(322);
    const tileHeight = scalar(323);
    const across = Math.ceil(width / tileWidth);
    const down = Math.ceil(height / tileHeight);
    if (tileOffsets.length < across * down || tileByteCounts.length < across * down) throw new Error('TIFF tile table is incomplete');
    for (let tileY = 0; tileY < down; tileY++) for (let tileX = 0; tileX < across; tileX++) {
      const tileIndex = tileY * across + tileX;
      const sourceOffset = tileOffsets[tileIndex];
      const sourceBytes = tileByteCounts[tileIndex];
      if (sourceOffset + sourceBytes > view.byteLength || sourceBytes < tileWidth * tileHeight * 4) throw new Error('TIFF tile payload is truncated');
      for (let y = 0; y < tileHeight && tileY * tileHeight + y < height; y++) {
        for (let x = 0; x < tileWidth && tileX * tileWidth + x < width; x++) {
          values[(tileY * tileHeight + y) * width + tileX * tileWidth + x] = view.getFloat32(sourceOffset + (y * tileWidth + x) * 4, little);
        }
      }
    }
  } else {
    const stripOffsets = tags.get(273);
    const stripByteCounts = tags.get(279);
    const rowsPerStrip = scalar(278, height);
    if (!stripOffsets || !stripByteCounts || stripOffsets.length !== stripByteCounts.length) throw new Error('TIFF has no supported pixel layout');
    for (let strip = 0; strip < stripOffsets.length; strip++) {
      const startRow = strip * rowsPerStrip;
      const rows = Math.min(rowsPerStrip, height - startRow);
      const requiredBytes = rows * width * 4;
      if (stripOffsets[strip] + requiredBytes > view.byteLength || stripByteCounts[strip] < requiredBytes) throw new Error('TIFF strip payload is truncated');
      for (let item = 0; item < rows * width; item++) values[startRow * width + item] = view.getFloat32(stripOffsets[strip] + item * 4, little);
    }
  }
  return Object.freeze({ width, height, values });
}
