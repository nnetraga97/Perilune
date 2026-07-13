import sharp from 'sharp';

function assertLogicalRgLength(data: Uint8Array, width: number, height: number): void {
  if (data.byteLength !== width * height * 2) {
    throw new Error(`Expected ${width}x${height} RG data (${width * height * 2} bytes), got ${data.byteLength}`);
  }
}

/**
 * Resize logical R and G data independently. Image libraries commonly treat a
 * two-channel raster as grayscale + alpha, which can premultiply one logical
 * data channel into the other during filtering.
 */
export async function resizeLogicalRg(
  data: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  assertLogicalRgLength(data, sourceWidth, sourceHeight);
  const red = Buffer.allocUnsafe(sourceWidth * sourceHeight);
  const green = Buffer.allocUnsafe(sourceWidth * sourceHeight);
  for (let pixel = 0; pixel < sourceWidth * sourceHeight; pixel++) {
    red[pixel] = data[pixel * 2];
    green[pixel] = data[pixel * 2 + 1];
  }
  const resizeChannel = async (channel: Buffer): Promise<Buffer> => {
    const resized = await sharp(channel, {
      raw: { width: sourceWidth, height: sourceHeight, channels: 1 },
      sequentialRead: true,
    })
      .resize(targetWidth, targetHeight, { kernel: sharp.kernel.lanczos3 })
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (resized.info.channels !== 1 || resized.data.byteLength !== targetWidth * targetHeight) {
      throw new Error(`Logical RG resize produced ${resized.info.channels} channels (${resized.data.byteLength} bytes)`);
    }
    return resized.data;
  };
  const [resizedRed, resizedGreen] = await Promise.all([resizeChannel(red), resizeChannel(green)]);
  const resized = Buffer.allocUnsafe(targetWidth * targetHeight * 2);
  for (let pixel = 0; pixel < targetWidth * targetHeight; pixel++) {
    resized[pixel * 2] = resizedRed[pixel];
    resized[pixel * 2 + 1] = resizedGreen[pixel];
  }
  return resized;
}

/** Expand logical RG data to a truecolor fallback without changing channels. */
export function expandLogicalRgToRgb(data: Uint8Array, width: number, height: number): Buffer {
  assertLogicalRgLength(data, width, height);
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = data[pixel * 2];
    rgb[pixel * 3 + 1] = data[pixel * 2 + 1];
    rgb[pixel * 3 + 2] = 0;
  }
  return rgb;
}
