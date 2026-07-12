import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { recipeForBody } from '../src/sim/terrainRecipe';
import {
  buildScatterRecipe,
  hashScatterRecipe,
  parseScatterRecipe,
  scatterCellSeed,
  scatterRecipeForBody,
  scatterRecordId,
  SCATTER_CELL_QUANTUM,
  SCATTER_CELL_RESOLUTION,
  type PhysicalScatterRecipe,
} from '../src/sim/scatterRecipe';
import { generateVeyraScatter } from '../scripts/lib/veyra-scatter';
import artifact from '../src/generated/veyra-scatter.json';

const game = new GameState();
const veyra = game.universe.get('veyra');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('physical scatter recipe', () => {
  it('parses the compiled Veyra artifact and recomputes a matching content hash', () => {
    const recipe = parseScatterRecipe(artifact);
    expect(recipe.bodyId).toBe('veyra');
    expect(recipe.formatVersion).toBe(1);
    expect(recipe.recordCount).toBeGreaterThan(0);
    expect(recipe.hash).toMatch(/^[a-f0-9]{32}$/);
    const { hash, ...body } = recipe;
    expect(hashScatterRecipe(body)).toBe(hash);
  });

  it('resolves a distinct scatter hash per body and caches the result', () => {
    const recipe = scatterRecipeForBody(veyra);
    expect(recipe.hash).not.toBe(recipeForBody(veyra).hash);
    expect(recipe.terrainRecipeHash).toBe(recipeForBody(veyra).hash);
    expect(scatterRecipeForBody(veyra)).toBe(recipe);
    const palla = game.universe.get('palla');
    const empty = scatterRecipeForBody(palla);
    expect(empty.recordCount).toBe(0);
    expect(empty.hash).not.toBe(recipeForBody(palla).hash);
    expect(empty.hash).not.toBe(recipe.hash);
  });

  it('keeps every record on land with a valid proxy, in-range coords, sorted unique ids', () => {
    const recipe = scatterRecipeForBody(veyra);
    const ids = new Set<string>();
    let previousCellKey = -1;
    let total = 0;
    for (const cell of recipe.cells) {
      expect(cell.face).toBeGreaterThanOrEqual(0);
      expect(cell.face).toBeLessThan(6);
      expect(cell.cx).toBeGreaterThanOrEqual(0);
      expect(cell.cx).toBeLessThan(SCATTER_CELL_RESOLUTION);
      const cellKey = (cell.face * SCATTER_CELL_RESOLUTION + cell.cx) * SCATTER_CELL_RESOLUTION + cell.cy;
      expect(cellKey).toBeGreaterThan(previousCellKey);
      previousCellKey = cellKey;
      expect(cell.records.length).toBeGreaterThan(0);
      let previousId = '';
      for (const record of cell.records) {
        total++;
        expect(record.id).toMatch(/^[a-f0-9]{16}$/);
        expect(ids.has(record.id)).toBe(false);
        expect(record.id > previousId).toBe(true);
        ids.add(record.id);
        previousId = record.id;
        expect(record.biome).toBeGreaterThanOrEqual(1); // never ocean
        expect(['sphere', 'capsule', 'compound-sphere']).toContain(record.proxy);
        expect(record.qu).toBeGreaterThanOrEqual(0);
        expect(record.qu).toBeLessThan(SCATTER_CELL_QUANTUM);
        expect(record.qRadius).toBeGreaterThan(0);
        expect(record.qHeight).toBeGreaterThan(0);
      }
    }
    expect(total).toBe(recipe.recordCount);
  });

  it('derives stable ids and distinct seeds for neighboring cells', () => {
    const a = scatterRecordId('veyra', 'deadbeef'.repeat(4), { face: 1, cx: 4, cy: 9 }, 0);
    const b = scatterRecordId('veyra', 'deadbeef'.repeat(4), { face: 1, cx: 4, cy: 9 }, 0);
    expect(a).toBe(b);
    expect(a).not.toBe(scatterRecordId('veyra', 'deadbeef'.repeat(4), { face: 1, cx: 4, cy: 9 }, 1));
    const seedA = scatterCellSeed('veyra', 'deadbeef'.repeat(4), { face: 2, cx: 5, cy: 5 });
    const seedB = scatterCellSeed('veyra', 'deadbeef'.repeat(4), { face: 2, cx: 6, cy: 5 });
    expect(seedA).not.toBe(seedB);
  });

  it('is quality-invariant: the recipe carries no tier and is identical per body', () => {
    const first = scatterRecipeForBody(veyra);
    expect('tier' in first).toBe(false);
    // Records are the canonical physical set; identical no matter the render tier.
    expect(scatterRecipeForBody(veyra).cells).toBe(first.cells);
  });

  it('rejects structural corruption before the recipe can be trusted', () => {
    const good = parseScatterRecipe(artifact);
    // Duplicate id across cells.
    const dupe = clone(artifact) as PhysicalScatterRecipe;
    if (dupe.cells.length >= 2 && dupe.cells[1].records.length >= 1 && dupe.cells[0].records.length >= 1) {
      (dupe.cells[1].records[0] as { id: string }).id = dupe.cells[0].records[0].id;
      expect(() => parseScatterRecipe(dupe)).toThrow();
    }
    // Ocean obstacle.
    const ocean = clone(good) as PhysicalScatterRecipe;
    (ocean.cells[0].records[0] as { biome: number }).biome = 0;
    expect(() => parseScatterRecipe(ocean)).toThrow(/ocean/i);
    // Tampered hash.
    const tampered = clone(good) as PhysicalScatterRecipe;
    (tampered as { hash: string }).hash = '0'.repeat(32);
    expect(() => parseScatterRecipe(tampered)).toThrow(/hash mismatch/i);
    // Unsorted cells.
    const unsorted = clone(good) as PhysicalScatterRecipe;
    if (unsorted.cells.length >= 2) {
      const swap = [unsorted.cells[1], unsorted.cells[0], ...unsorted.cells.slice(2)];
      (unsorted as { cells: unknown }).cells = swap;
      expect(() => parseScatterRecipe(unsorted)).toThrow();
    }
  });

  it('excludes ocean, places on land, and regenerates deterministically', () => {
    const width = 64;
    const height = 32;
    const ocean = new Int16Array(width * height).fill(-2000); // -1000 m everywhere
    const oceanRecipe = generateVeyraScatter({
      bodyId: 'veyra', terrainRecipeHash: 'a'.repeat(32), radius: 600_000,
      height: { width, height, texels: ocean },
    });
    expect(oceanRecipe.recordCount).toBe(0);

    const land = new Int16Array(width * height).fill(1000); // +500 m everywhere
    const first = generateVeyraScatter({
      bodyId: 'veyra', terrainRecipeHash: 'a'.repeat(32), radius: 600_000,
      height: { width, height, texels: land },
    });
    expect(first.recordCount).toBeGreaterThan(0);
    for (const cell of first.cells) for (const record of cell.records) expect(record.biome).toBeGreaterThanOrEqual(1);
    const second = generateVeyraScatter({
      bodyId: 'veyra', terrainRecipeHash: 'a'.repeat(32), radius: 600_000,
      height: { width, height, texels: land },
    });
    expect(second.hash).toBe(first.hash);
  });

  it('builds a deterministic hash from the same cells', () => {
    const cells = scatterRecipeForBody(veyra).cells.slice(0, 3);
    const a = buildScatterRecipe({ bodyId: 'veyra', terrainRecipeHash: 'a'.repeat(32), cells });
    const b = buildScatterRecipe({ bodyId: 'veyra', terrainRecipeHash: 'a'.repeat(32), cells });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{32}$/);
  });
});
