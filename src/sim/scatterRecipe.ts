/**
 * Versioned, content-addressed physical-scatter recipe.
 *
 * The canonical scatter artifact is compiled once from the canonical quantized
 * height buffer with a specified integer PRNG (never from lossy/GPU textures)
 * and is shared verbatim by rendering, save validation, broadphase, and
 * collision. Physical obstacle IDs, positions, proxy shapes, and behavior are
 * identical on every quality tier; visual density is a quality-scaled view of
 * the same cells and lives in the renderer, not here.
 */
import type { Body } from './universe';
import { recipeForBody } from './terrainRecipe';
import veyraScatterArtifact from '../generated/veyra-scatter.json';

export const SCATTER_RECIPE_VERSION = 1;
/** Cube-face cells per edge. Deterministic broadphase grid; must stay a power of two. */
export const SCATTER_CELL_RESOLUTION = 32;
/** In-cell coordinate quantization (each axis spans [0, SCATTER_CELL_QUANTUM)). */
export const SCATTER_CELL_QUANTUM = 65536;
/** Radius/height quantization step in meters. */
export const SCATTER_SIZE_QUANTUM_METERS = 0.01;

export type ScatterProxyKind = 'sphere' | 'capsule' | 'compound-sphere';

const PROXY_KINDS: readonly ScatterProxyKind[] = ['sphere', 'capsule', 'compound-sphere'];

export interface ScatterCellId {
  readonly face: number;
  readonly cx: number;
  readonly cy: number;
}

export interface PhysicalScatterRecord {
  /** Stable 64-bit identity as lowercase hex (16 chars). */
  readonly id: string;
  /** Quantized in-cell coordinates in [0, SCATTER_CELL_QUANTUM). */
  readonly qu: number;
  readonly qv: number;
  /** Quantized proxy radius and standing height in SCATTER_SIZE_QUANTUM_METERS units. */
  readonly qRadius: number;
  readonly qHeight: number;
  readonly proxy: ScatterProxyKind;
  /** Integer biome class (0 = ocean is never emitted here; 1 lowland, 2 mid, 3 highland). */
  readonly biome: number;
  /** Integer visual class used by the renderer to pick a mesh family. */
  readonly visual: number;
}

export interface ScatterCell extends ScatterCellId {
  /** Per-cell seed for deterministic visual-scatter regeneration at runtime. */
  readonly seed: number;
  readonly records: readonly PhysicalScatterRecord[];
}

export interface PhysicalScatterRecipe {
  readonly formatVersion: number;
  readonly bodyId: string;
  readonly terrainRecipeHash: string;
  /** 32-hex content hash over everything except this field. */
  readonly hash: string;
  readonly cellResolution: number;
  readonly cellQuantum: number;
  readonly sizeQuantumMeters: number;
  readonly recordCount: number;
  readonly cells: readonly ScatterCell[];
}

const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(text: string, offset: bigint): bigint {
  let hash = offset;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash;
}

/** Stable 64-bit record identity as 16 lowercase hex chars. */
export function scatterRecordId(
  bodyId: string,
  terrainRecipeHash: string,
  cell: ScatterCellId,
  index: number,
): string {
  const content = `${bodyId}|${terrainRecipeHash}|${cell.face}|${cell.cx}|${cell.cy}|${index}`;
  return fnv1a64(content, 0x27d4eb2f165667c5n).toString(16).padStart(16, '0');
}

/** Deterministic 32-bit cell seed for visual regeneration. */
export function scatterCellSeed(bodyId: string, terrainRecipeHash: string, cell: ScatterCellId): number {
  const content = `seed|${bodyId}|${terrainRecipeHash}|${cell.face}|${cell.cx}|${cell.cy}`;
  return Number(fnv1a64(content, 0x100000001b3n) & 0xffffffffn) >>> 0;
}

/** Documented integer PRNG (mulberry32); yields uint32 stream for deterministic placement. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

export function proxyKindFromIndex(index: number): ScatterProxyKind {
  return PROXY_KINDS[((index % PROXY_KINDS.length) + PROXY_KINDS.length) % PROXY_KINDS.length];
}

/** Serialize the recipe to canonical content (excluding its own hash) for hashing. */
function scatterRecipeContent(recipe: Omit<PhysicalScatterRecipe, 'hash'>): string {
  return JSON.stringify([
    recipe.formatVersion,
    recipe.bodyId,
    recipe.terrainRecipeHash,
    recipe.cellResolution,
    recipe.cellQuantum,
    recipe.sizeQuantumMeters,
    recipe.recordCount,
    recipe.cells.map((cell) => [
      cell.face, cell.cx, cell.cy, cell.seed,
      cell.records.map((record) => [
        record.id, record.qu, record.qv, record.qRadius, record.qHeight, record.proxy, record.biome, record.visual,
      ]),
    ]),
  ]);
}

/** 32-hex content hash of a scatter recipe body (distinct from the terrain hash). */
export function hashScatterRecipe(recipe: Omit<PhysicalScatterRecipe, 'hash'>): string {
  const content = `scatter-v${SCATTER_RECIPE_VERSION}|${scatterRecipeContent(recipe)}`;
  return (
    fnv1a64(content, 0xcbf29ce484222325n).toString(16).padStart(16, '0') +
    fnv1a64(content, 0x84222325cbf29ce4n).toString(16).padStart(16, '0')
  );
}

/** Assemble a recipe from cells and compute its content hash. */
export function buildScatterRecipe(params: {
  bodyId: string;
  terrainRecipeHash: string;
  cells: readonly ScatterCell[];
}): PhysicalScatterRecipe {
  const cells = [...params.cells].sort(compareCells);
  const recordCount = cells.reduce((sum, cell) => sum + cell.records.length, 0);
  const body: Omit<PhysicalScatterRecipe, 'hash'> = {
    formatVersion: SCATTER_RECIPE_VERSION,
    bodyId: params.bodyId,
    terrainRecipeHash: params.terrainRecipeHash,
    cellResolution: SCATTER_CELL_RESOLUTION,
    cellQuantum: SCATTER_CELL_QUANTUM,
    sizeQuantumMeters: SCATTER_SIZE_QUANTUM_METERS,
    recordCount,
    cells,
  };
  return { ...body, hash: hashScatterRecipe(body) };
}

export function compareCells(a: ScatterCellId, b: ScatterCellId): number {
  return a.face - b.face || a.cx - b.cx || a.cy - b.cy;
}

/**
 * Validate and normalize a parsed scatter artifact. Throws on any structural
 * defect (bad bounds, unsorted or duplicate IDs, cell-ownership violation, or
 * a hash that does not match the content) before it can be trusted.
 */
export function parseScatterRecipe(raw: unknown): PhysicalScatterRecipe {
  if (typeof raw !== 'object' || raw === null) throw new Error('Scatter recipe must be an object');
  const data = raw as Record<string, unknown>;
  if (data.formatVersion !== SCATTER_RECIPE_VERSION) {
    throw new Error(`Unsupported scatter format version ${String(data.formatVersion)}`);
  }
  if (typeof data.bodyId !== 'string' || !data.bodyId) throw new Error('Scatter recipe bodyId missing');
  if (!/^[a-f0-9]{32}$/.test(String(data.terrainRecipeHash))) throw new Error('Scatter terrainRecipeHash must be 32 hex');
  if (!/^[a-f0-9]{32}$/.test(String(data.hash))) throw new Error('Scatter hash must be 32 hex');
  if (data.cellResolution !== SCATTER_CELL_RESOLUTION) throw new Error('Scatter cellResolution mismatch');
  if (data.cellQuantum !== SCATTER_CELL_QUANTUM) throw new Error('Scatter cellQuantum mismatch');
  if (data.sizeQuantumMeters !== SCATTER_SIZE_QUANTUM_METERS) throw new Error('Scatter sizeQuantumMeters mismatch');
  if (!Array.isArray(data.cells)) throw new Error('Scatter cells must be an array');

  const cells: ScatterCell[] = [];
  const seenIds = new Set<string>();
  let previous: ScatterCellId | null = null;
  let recordCount = 0;
  for (const rawCell of data.cells) {
    const cell = rawCell as Record<string, unknown>;
    const face = cell.face as number;
    const cx = cell.cx as number;
    const cy = cell.cy as number;
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new Error('Scatter cell face out of range');
    for (const coord of [cx, cy]) {
      if (!Number.isInteger(coord) || coord < 0 || coord >= SCATTER_CELL_RESOLUTION) {
        throw new Error('Scatter cell coordinate out of range');
      }
    }
    if (previous && compareCells(previous, { face, cx, cy }) >= 0) throw new Error('Scatter cells must be sorted and unique');
    previous = { face, cx, cy };
    if (!Number.isInteger(cell.seed) || (cell.seed as number) < 0) throw new Error('Scatter cell seed must be a uint32');
    if (!Array.isArray(cell.records)) throw new Error('Scatter cell records must be an array');
    const records: PhysicalScatterRecord[] = [];
    let previousId: string | null = null;
    for (const rawRecord of cell.records) {
      const record = rawRecord as Record<string, unknown>;
      if (!/^[a-f0-9]{16}$/.test(String(record.id))) throw new Error('Scatter record id must be 16 hex');
      if (seenIds.has(record.id as string)) throw new Error(`Duplicate scatter record id ${String(record.id)}`);
      if (previousId !== null && (record.id as string) <= previousId) throw new Error('Scatter records must be sorted by id');
      seenIds.add(record.id as string);
      previousId = record.id as string;
      for (const [value, label] of [[record.qu, 'qu'], [record.qv, 'qv']] as const) {
        if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= SCATTER_CELL_QUANTUM) {
          throw new Error(`Scatter record ${label} out of range`);
        }
      }
      for (const [value, label] of [[record.qRadius, 'qRadius'], [record.qHeight, 'qHeight']] as const) {
        if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Scatter record ${label} must be a positive integer`);
      }
      if (!PROXY_KINDS.includes(record.proxy as ScatterProxyKind)) throw new Error('Scatter record proxy kind invalid');
      if (!Number.isInteger(record.biome) || (record.biome as number) < 1) throw new Error('Scatter record biome must exclude ocean');
      if (!Number.isInteger(record.visual) || (record.visual as number) < 0) throw new Error('Scatter record visual class invalid');
      records.push({
        id: record.id as string,
        qu: record.qu as number,
        qv: record.qv as number,
        qRadius: record.qRadius as number,
        qHeight: record.qHeight as number,
        proxy: record.proxy as ScatterProxyKind,
        biome: record.biome as number,
        visual: record.visual as number,
      });
    }
    recordCount += records.length;
    cells.push({ face, cx, cy, seed: cell.seed as number, records });
  }
  if (data.recordCount !== recordCount) throw new Error('Scatter recordCount does not match cells');

  const normalized: PhysicalScatterRecipe = {
    formatVersion: SCATTER_RECIPE_VERSION,
    bodyId: data.bodyId,
    terrainRecipeHash: data.terrainRecipeHash as string,
    hash: data.hash as string,
    cellResolution: SCATTER_CELL_RESOLUTION,
    cellQuantum: SCATTER_CELL_QUANTUM,
    sizeQuantumMeters: SCATTER_SIZE_QUANTUM_METERS,
    recordCount,
    cells,
  };
  const expectedHash = hashScatterRecipe(normalized);
  if (expectedHash !== normalized.hash) {
    throw new Error(`Scatter recipe hash mismatch: expected ${expectedHash}, got ${normalized.hash}`);
  }
  return normalized;
}

const recipeCache = new Map<string, PhysicalScatterRecipe>();

/** Empty deterministic recipe for bodies without a compiled scatter artifact. */
function emptyScatterRecipe(bodyId: string, terrainRecipeHash: string): PhysicalScatterRecipe {
  return buildScatterRecipe({ bodyId, terrainRecipeHash, cells: [] });
}

/**
 * The authoritative scatter recipe for a body. Veyra loads its compiled
 * artifact; every other body currently resolves to a deterministic empty
 * recipe whose hash is still distinct from its terrain hash.
 */
export function scatterRecipeForBody(body: Body): PhysicalScatterRecipe {
  const cached = recipeCache.get(body.id);
  if (cached) return cached;
  const terrainRecipeHash = recipeForBody(body).hash;
  let recipe: PhysicalScatterRecipe;
  if (body.id === 'veyra') {
    recipe = parseScatterRecipe(veyraScatterArtifact);
    if (recipe.bodyId !== body.id) throw new Error(`Scatter artifact body mismatch for ${body.id}`);
    if (recipe.terrainRecipeHash !== terrainRecipeHash) {
      throw new Error(`Scatter artifact terrain hash drift for ${body.id}`);
    }
  } else {
    recipe = emptyScatterRecipe(body.id, terrainRecipeHash);
  }
  recipeCache.set(body.id, recipe);
  return recipe;
}
