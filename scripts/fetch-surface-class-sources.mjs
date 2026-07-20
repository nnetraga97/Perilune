import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOT = path.join(ROOT, 'assets/planets/sources');
const CLASS_ROOT = path.join(ROOT, 'assets/planets/classification');
const GSHHG_URL = 'https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip';
const GSHHG_BYTES = 149_157_845;
const GSHHG_ARCHIVE = path.join(SOURCE_ROOT, 'noaa-gshhg-2.3.7/gshhg-shp-2.3.7.zip');
const GSHHG_EXTRACTED = path.join(SOURCE_ROOT, 'noaa-gshhg-2.3.7/extracted');
const NWI_URL = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
const NWI_BBOX = Object.freeze([-80.8, 28.45, -80.2, 28.75]);
const NWI_SNAPSHOT = path.join(SOURCE_ROOT, 'usfws-nwi-ksc/nwi-ksc-2026-07-20.geojson');
const NWI_BATCH_ROOT = path.join(SOURCE_ROOT, 'usfws-nwi-ksc/batches-2026-07-20');
const NWI_STATE_ARTIFACT = 'https://documentst.ecosphere.fws.gov/wetlands/data/State-Downloads/FL_geopackage_wetlands.zip';

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchFile(url, destination, expectedBytes) {
  try {
    const existing = await stat(destination);
    if (existing.size === expectedBytes) return;
  } catch {}
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Failed ${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared !== expectedBytes) throw new Error(`${url} length changed: expected ${expectedBytes}, got ${declared}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const received = (await stat(partial)).size;
  if (received !== expectedBytes) throw new Error(`${url} truncated: expected ${expectedBytes}, got ${received}`);
  await rename(partial, destination);
}

async function nwiPost(params) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(NWI_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function nwiGet(params) {
  const response = await fetch(`${NWI_URL}?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`NWI GET failed: HTTP ${response.status}`);
  return response.json();
}

async function fetchNwiSnapshot() {
  try {
    const cached = JSON.parse(await readFile(NWI_SNAPSHOT, 'utf8'));
    if (cached.type === 'FeatureCollection'
      && Array.isArray(cached.features)
      && cached.features.length >= 1_000) {
      console.log(`Using cached NWI KSC snapshot with ${cached.features.length} features.`);
      return cached;
    }
  } catch {}

  const [xmin, ymin, xmax, ymax] = NWI_BBOX;
  const geometry = JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } });
  const idsResponse = await nwiGet({
    where: '1=1', geometry, geometryType: 'esriGeometryEnvelope', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', returnIdsOnly: 'true', f: 'json',
  });
  const ids = [...(idsResponse.objectIds ?? [])].sort((a, b) => a - b);
  if (ids.length < 1_000 || ids.length > 20_000) throw new Error(`Unexpected NWI KSC feature count ${ids.length}`);
  console.log(`Resolved ${ids.length} NWI KSC feature IDs.`);
  await mkdir(NWI_BATCH_ROOT, { recursive: true });
  const features = [];
  const fetchBatch = async (batch) => {
    const batchPath = path.join(NWI_BATCH_ROOT, `${batch[0]}-${batch.at(-1)}.json`);
    try {
      const cached = JSON.parse(await readFile(batchPath, 'utf8'));
      if (Array.isArray(cached.features)) {
        features.push(...cached.features);
        return;
      }
    } catch {}
    let response;
    try {
      response = await nwiPost({
        objectIds: batch.join(','),
        outFields: 'Wetlands.OBJECTID,Wetlands.ATTRIBUTE,Wetlands.WETLAND_TYPE,Wetlands.ACRES',
        returnGeometry: 'true', outSR: '4326', geometryPrecision: '6',
        maxAllowableOffset: '0.00003', f: 'geojson',
      });
    } catch (error) {
      if (batch.length <= 10) throw error;
      const middle = Math.floor(batch.length / 2);
      await fetchBatch(batch.slice(0, middle));
      await fetchBatch(batch.slice(middle));
      return;
    }
    if (!Array.isArray(response.features)) throw new Error(`NWI batch did not return GeoJSON features`);
    const normalized = [];
    for (const feature of response.features) {
      const properties = feature.properties ?? {};
      normalized.push({
        type: 'Feature',
        id: Number(properties['Wetlands.OBJECTID'] ?? properties.OBJECTID ?? feature.id),
        properties: {
          objectId: Number(properties['Wetlands.OBJECTID'] ?? properties.OBJECTID ?? feature.id),
          attribute: String(properties['Wetlands.ATTRIBUTE'] ?? properties.ATTRIBUTE ?? ''),
          wetlandType: String(properties['Wetlands.WETLAND_TYPE'] ?? properties.WETLAND_TYPE ?? ''),
          acres: Number(properties['Wetlands.ACRES'] ?? properties.ACRES ?? 0),
        },
        geometry: feature.geometry,
      });
    }
    await writeFile(batchPath, `${JSON.stringify({ features: normalized })}\n`);
    features.push(...normalized);
  };
  for (let index = 0; index < ids.length; index += 250) {
    await fetchBatch(ids.slice(index, index + 250));
    console.log(`Fetched ${Math.min(index + 250, ids.length)}/${ids.length} NWI features...`);
  }
  features.sort((a, b) => a.properties.objectId - b.properties.objectId);
  if (features.length !== ids.length) throw new Error(`NWI snapshot expected ${ids.length} features, got ${features.length}`);
  const collection = { type: 'FeatureCollection', bbox: NWI_BBOX, features };
  await mkdir(path.dirname(NWI_SNAPSHOT), { recursive: true });
  await writeFile(NWI_SNAPSHOT, `${JSON.stringify(collection)}\n`);
  return collection;
}

await fetchFile(GSHHG_URL, GSHHG_ARCHIVE, GSHHG_BYTES);
await mkdir(GSHHG_EXTRACTED, { recursive: true });
execFileSync('unzip', ['-oq', GSHHG_ARCHIVE, '-d', GSHHG_EXTRACTED], { stdio: 'inherit' });
const gshhgPaths = [1, 2, 3, 4, 5].map((level) =>
  path.join(GSHHG_EXTRACTED, `GSHHS_shp/f/GSHHS_f_L${level}.shp`));
for (const filePath of gshhgPaths) await stat(filePath);
const nwi = await fetchNwiSnapshot();

const gshhgLock = {
  schemaVersion: 1,
  sourceId: 'noaa-gshhg-2-3-7-full',
  version: '2.3.7',
  artifactUrl: GSHHG_URL,
  artifactBytes: GSHHG_BYTES,
  artifactSha256: await sha256File(GSHHG_ARCHIVE),
  projection: 'WGS84 geographic',
  levels: gshhgPaths.map((filePath, index) => ({
    level: index + 1,
    path: path.relative(ROOT, filePath),
    bytes: null,
  })),
};
for (const level of gshhgLock.levels) level.bytes = (await stat(path.join(ROOT, level.path))).size;
const nwiBytes = await readFile(NWI_SNAPSHOT);
const nwiLock = {
  schemaVersion: 1,
  sourceId: 'usfws-nwi-ksc-snapshot-2026-07-20',
  sourceUrl: NWI_URL,
  stateArtifactUrl: NWI_STATE_ARTIFACT,
  stateArtifactObservedBytes: 1_273_011_918,
  acquisition: 'bounded ArcGIS FeatureServer snapshot; statewide artifact retained as provenance only',
  observedAt: '2026-07-20',
  coverage: NWI_BBOX,
  projection: 'EPSG:4326',
  featureCount: nwi.features.length,
  snapshotPath: path.relative(ROOT, NWI_SNAPSHOT),
  snapshotSha256: createHash('sha256').update(nwiBytes).digest('hex'),
};
await mkdir(CLASS_ROOT, { recursive: true });
await writeFile(path.join(CLASS_ROOT, 'gshhg-2.3.7.lock.json'), `${JSON.stringify(gshhgLock, null, 2)}\n`);
await writeFile(path.join(CLASS_ROOT, 'nwi-ksc.lock.json'), `${JSON.stringify(nwiLock, null, 2)}\n`);
console.log(`Pinned GSHHG ${gshhgLock.artifactSha256} and ${nwi.features.length} NWI KSC features.`);
