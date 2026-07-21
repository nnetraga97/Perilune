import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const outputPath = resolve(root, 'src/generated/earth-surface-class-authority.json');
const write = process.argv.includes('--write');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodeRuns(bytes: Uint8Array): string {
  const chunks: number[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const code = bytes[offset];
    let end = offset + 1;
    while (end < bytes.length && bytes[end] === code && end - offset < 0xffff_ffff) end++;
    const length = end - offset;
    chunks.push(code, length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff);
    offset = end;
  }
  return Buffer.from(chunks).toString('base64');
}

async function readExactClass(path: string): Promise<{ width: number; height: number; bytes: Uint8Array; checksum: string }> {
  const file = readFileSync(path);
  const decoded = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 1 && decoded.info.channels !== 3 && decoded.info.channels !== 4) {
    throw new Error(`${path} must decode as grayscale-compatible surface-class data`);
  }
  const bytes = new Uint8Array(decoded.info.width * decoded.info.height);
  for (let index = 0; index < bytes.length; index++) {
    const offset = index * decoded.info.channels;
    const code = decoded.data[offset];
    if (code > 6 || (decoded.info.channels >= 3 &&
      (decoded.data[offset + 1] !== code || decoded.data[offset + 2] !== code))) {
      throw new Error(`${path} contains a non-exact surface-class texel`);
    }
    bytes[index] = code;
  }
  return {
    width: decoded.info.width,
    height: decoded.info.height,
    bytes,
    checksum: sha256(file),
  };
}

const global = await readExactClass(resolve(root, 'assets/planets/generated/earth/high/surfaceClass.png'));
const regional = await readExactClass(resolve(root, 'assets/planets/generated/earth/high/surfaceClassRegional.png'));
const artifact = {
  schemaVersion: 1,
  codeVersion: 'earth-surface-class-v1',
  global: {
    width: global.width,
    height: global.height,
    boundsDegrees: [-180, -90, 180, 90],
    sourcePngSha256: global.checksum,
    runsBase64: encodeRuns(global.bytes),
  },
  regional: {
    width: regional.width,
    height: regional.height,
    boundsDegrees: [-80.8, 28.45, -80.2, 28.75],
    sourcePngSha256: regional.checksum,
    runsBase64: encodeRuns(regional.bytes),
  },
};
const output = `${JSON.stringify(artifact)}\n`;
if (write) writeFileSync(outputPath, output);
else if (readFileSync(outputPath, 'utf8') !== output) {
  throw new Error('Earth surface-class CPU authority is stale; run compile:surface-class-authority -- --write');
}
console.log(`Earth surface-class CPU authority ${write ? 'wrote' : 'matches'} ${outputPath}`);
