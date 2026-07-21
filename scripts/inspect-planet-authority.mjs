import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SOL_SYSTEM } from '../src/content/system.ts';
import { Vec3 } from '../src/core/vec3.ts';
import { LAUNCH_PAD_TERRAIN_BLEND_RADIUS, LAUNCH_PAD_TERRAIN_FLAT_RADIUS } from '../src/sim/launchSite.ts';
import { sampleSourceMacroHeight } from '../src/sim/sourceHeightAuthority.ts';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe.ts';
import { Universe } from '../src/sim/universe.ts';
import { decodeMacroHeight } from './lib/scientific-global-maps.ts';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const OUTPUT_JSON = path.join(ROOT, 'docs/performance/reference/sol-source-authority-baseline-2026-07.json');
const OUTPUT_MD = path.join(ROOT, 'docs/performance/reference/sol-source-authority-baseline-2026-07.md');
const universe = new Universe([...SOL_SYSTEM], 'earth');

const SOURCE = Object.freeze({
  earth: {
    path: 'assets/planets/sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_surface.tif',
    kind: 'float', scale: 1, offset: 0, datum: 'EGM2008 geoid',
  },
  moon: {
    path: 'assets/planets/sources/nasa-lro-palla/ldem_16_uint.tif',
    kind: 'ushort', scale: 0.5, offset: -10_000, datum: '1737400 m LOLA reference sphere',
  },
});

const CONTROL_POINTS = Object.freeze([
  { id: 'earth-ksc-diagnostic', bodyId: 'earth', latitude: 28.5728722, longitude: -80.6489808 },
  { id: 'earth-lc39b', bodyId: 'earth', latitude: 28.6272, longitude: -80.6209 },
  { id: 'earth-atlantic', bodyId: 'earth', latitude: 28.6272, longitude: -80.25 },
  { id: 'earth-antimeridian-west', bodyId: 'earth', latitude: 0, longitude: -179.999 },
  { id: 'earth-antimeridian-east', bodyId: 'earth', latitude: 0, longitude: 179.999 },
  { id: 'earth-north-pole', bodyId: 'earth', latitude: 90, longitude: 0 },
  { id: 'earth-south-pole', bodyId: 'earth', latitude: -90, longitude: 0 },
  { id: 'moon-equator-origin', bodyId: 'moon', latitude: 0, longitude: 0 },
  { id: 'moon-south-polar-reference', bodyId: 'moon', latitude: -87.5, longitude: 45 },
  { id: 'moon-antimeridian-west', bodyId: 'moon', latitude: 0, longitude: -179.999 },
  { id: 'moon-antimeridian-east', bodyId: 'moon', latitude: 0, longitude: 179.999 },
  { id: 'moon-north-pole', bodyId: 'moon', latitude: 90, longitude: 0 },
  { id: 'moon-south-pole', bodyId: 'moon', latitude: -90, longitude: 0 },
]);

const TRANSECTS = Object.freeze([
  {
    id: 'earth-ksc-coast', bodyId: 'earth',
    points: Array.from({ length: 15 }, (_, index) => ({ latitude: 28.6272, longitude: -80.95 + index * 0.05 })),
  },
  {
    id: 'moon-equatorial-relief', bodyId: 'moon',
    points: Array.from({ length: 11 }, (_, index) => ({ latitude: 0, longitude: -10 + index * 2 })),
  },
  {
    id: 'moon-south-pole-relief', bodyId: 'moon',
    points: Array.from({ length: 7 }, (_, index) => ({ latitude: -89.5 + index * 0.5, longitude: 45 })),
  },
]);

const metadataCache = new Map();
const imageCache = new Map();
const sourceDigestCache = new Map();

function fract(value) { return value - Math.floor(value); }

function rasterPixel(metadata, latitude, longitude) {
  const u = fract(longitude / 360 + 0.5);
  const v = Math.max(0, Math.min(1, 0.5 - latitude / 180));
  return {
    x: Math.max(0, Math.min(metadata.width - 1, Math.floor(u * metadata.width))),
    y: Math.max(0, Math.min(metadata.height - 1, Math.floor(v * metadata.height))),
  };
}

async function metadataFor(relativePath) {
  if (!metadataCache.has(relativePath)) {
    metadataCache.set(relativePath, await sharp(path.join(ROOT, relativePath), { limitInputPixels: false }).metadata());
  }
  return metadataCache.get(relativePath);
}

async function sourceDigest(relativePath) {
  if (!sourceDigestCache.has(relativePath)) {
    sourceDigestCache.set(
      relativePath,
      createHash('sha256').update(await readFile(path.join(ROOT, relativePath))).digest('hex'),
    );
  }
  return sourceDigestCache.get(relativePath);
}

async function rawPixel(relativePath, latitude, longitude, depth) {
  const metadata = await metadataFor(relativePath);
  const { x, y } = rasterPixel(metadata, latitude, longitude);
  let pipeline = sharp(path.join(ROOT, relativePath), { limitInputPixels: false })
    .extract({ left: x, top: y, width: 1, height: 1 });
  pipeline = depth === 'ushort' ? pipeline.toColourspace('grey16') : pipeline.toColourspace('b-w');
  const { data, info } = await pipeline.raw({ depth })
    .toBuffer({ resolveWithObject: true });
  const values = depth === 'float'
    ? new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
    : depth === 'ushort'
      ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2)
      : data;
  return { value: values[0], x, y, channels: info.channels, width: metadata.width, height: metadata.height };
}

async function decodedImage(relativePath) {
  if (!imageCache.has(relativePath)) {
    imageCache.set(relativePath, await sharp(path.join(ROOT, relativePath))
      .raw().toBuffer({ resolveWithObject: true }));
  }
  return imageCache.get(relativePath);
}

async function sampleGenerated(bodyId, tier, latitude, longitude) {
  const heightPath = `assets/planets/generated/${bodyId}/${tier}/heightMacro.png`;
  const heightImage = await decodedImage(heightPath);
  const pixel = rasterPixel(heightImage.info, latitude, longitude);
  const heightOffset = (pixel.y * heightImage.info.width + pixel.x) * heightImage.info.channels;
  const height = decodeMacroHeight(heightImage.data[heightOffset], heightImage.data[heightOffset + 1]);
  if (bodyId !== 'earth') return { heightMeters: height };
  const materialPath = `assets/planets/generated/earth/${tier}/material.png`;
  const materialImage = await decodedImage(materialPath);
  const materialOffset = (pixel.y * materialImage.info.width + pixel.x) * materialImage.info.channels;
  return { heightMeters: height, legacyOceanByte: materialImage.data[materialOffset + 2] };
}

function direction(latitude, longitude) {
  const phi = latitude * Math.PI / 180;
  const theta = longitude * Math.PI / 180;
  return new Vec3(Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi));
}

async function inspectPoint(point) {
  const source = SOURCE[point.bodyId];
  const raw = await rawPixel(source.path, point.latitude, point.longitude, source.kind);
  const rawHeight = raw.value * source.scale + source.offset;
  const vector = direction(point.latitude, point.longitude);
  const body = universe.get(point.bodyId);
  const recipe = recipeForBody(body);
  const tiers = {};
  for (const tier of ['low', 'medium', 'high']) {
    tiers[tier] = await sampleGenerated(point.bodyId, tier, point.latitude, point.longitude);
  }
  return {
    ...point,
    source: {
      path: source.path,
      sha256: await sourceDigest(source.path),
      datum: source.datum,
      pixel: [raw.x, raw.y],
      dimensions: [raw.width, raw.height],
      heightMeters: rawHeight,
    },
    tiers,
    cpuMacroHeightMeters: sampleSourceMacroHeight(point.bodyId, vector),
    recipeContactHeightMeters: evaluateRecipeHeight(recipe, vector),
    recipeHash: recipe.hash,
  };
}

const controls = [];
for (const point of CONTROL_POINTS) controls.push(await inspectPoint(point));
const transects = [];
for (const transect of TRANSECTS) {
  const points = [];
  for (const point of transect.points) {
    points.push(await inspectPoint({ ...point, bodyId: transect.bodyId, id: `${transect.id}-${points.length}` }));
  }
  transects.push({ id: transect.id, bodyId: transect.bodyId, points });
}

const report = {
  schemaVersion: 1,
  baselineCommit: '58b222ce1a150b43af3f00bbe59eb78bc5b9b145',
  generatedAt: '2026-07-20',
  interpolation: {
    sourceControlPoint: 'nearest source pixel center',
    generatedVisual: 'nearest decoded PNG pixel center',
    cpuAuthority: 'runtime bilinear seam-wrapped 512x256 Int16 half-metre grid',
  },
  launchEnvelope: {
    flatRadiusMeters: LAUNCH_PAD_TERRAIN_FLAT_RADIUS,
    blendRadiusMeters: LAUNCH_PAD_TERRAIN_BLEND_RADIUS,
  },
  controls,
  transects,
};

const rows = controls.map((point) => {
  const legacyMask = point.bodyId === 'earth'
    ? `${point.tiers.low.legacyOceanByte}/${point.tiers.medium.legacyOceanByte}/${point.tiers.high.legacyOceanByte}`
    : 'n/a';
  return `| ${point.id} | ${point.source.heightMeters.toFixed(3)} | ` +
    `${point.tiers.low.heightMeters.toFixed(3)} | ${point.tiers.medium.heightMeters.toFixed(3)} | ` +
    `${point.tiers.high.heightMeters.toFixed(3)} | ${point.cpuMacroHeightMeters.toFixed(3)} | ` +
    `${point.recipeContactHeightMeters.toFixed(3)} | ${legacyMask} |`;
});
const markdown = `# Sol Source Authority Baseline — 2026-07\n\n` +
  `Pre-correction numeric evidence from commit \`${report.baselineCommit}\`. Source samples, visual derivatives, ` +
  `the checked CPU macro grid, and recipe contact are reported independently. The legacy ocean bytes are diagnostic ` +
  `evidence only and are not accepted as semantic class.\n\n` +
  `| Control | Raw source m | Low m | Medium m | High m | CPU m | Contact m | Legacy ocean L/M/H |\n` +
  `|---|---:|---:|---:|---:|---:|---:|---|\n${rows.join('\n')}\n\n` +
  `Full KSC, lunar-equator, and lunar-south-pole transects are stored in the adjacent JSON report.\n`;

if (WRITE) {
  await writeFile(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(OUTPUT_MD, markdown);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_JSON)} and ${path.relative(ROOT, OUTPUT_MD)}`);
} else {
  console.log(markdown);
}
