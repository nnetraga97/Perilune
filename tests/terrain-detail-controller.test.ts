import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainDetailController } from '../src/render/planetDetail/terrainDetailController';
import { geographicBoundsForTerrainTile, selectTerrainVisualPages } from '../src/render/planetDetail/terrainDetailController';
import {
  createTerrainDetailMaterialState,
  TERRAIN_DETAIL_ATLAS_GRID,
  TERRAIN_DETAIL_PAGE_SLOTS,
} from '../src/render/planetDetail/terrainDetailMaterial';
import { createTerrainTileId, terrainTileAtDirection, terrainTileKey } from '../src/render/terrain/tile';

describe('terrain detail controller', () => {
  it('keeps Low on the complete resident parent without issuing work', () => {
    const material = new THREE.MeshStandardMaterial();
    material.userData.terrainDetail = createTerrainDetailMaterialState();
    const controller = new TerrainDetailController('earth', 6_378_137, 'low', material, () => []);
    expect(controller.stats()).toMatchObject({ state: 'disabled', gpuBytes: 0, pages: 0 });
    expect(material.userData.terrainDetail.enabled.value).toBe(0);
    controller.dispose();
    material.dispose();
  });

  it('drives a bounded atomic page set from selected leaves and prediction', () => {
    const camera = { x: 1, y: 0.02, z: 0.01 };
    const prediction = { x: 1, y: 0.08, z: 0.01 };
    const demand = [
      createTerrainTileId(0, 5, 15, 15),
      createTerrainTileId(0, 5, 16, 15),
      createTerrainTileId(0, 5, 15, 16),
      createTerrainTileId(0, 5, 16, 16),
    ];
    const pages = selectTerrainVisualPages(demand, camera, prediction, 8, 4);
    expect(pages.length).toBeLessThanOrEqual(4);
    expect(new Set(pages.map(terrainTileKey)).size).toBe(pages.length);
    expect(terrainTileKey(pages[0])).toBe(terrainTileKey(terrainTileAtDirection(camera, 8)));
  });

  it('retains a 3x3 low-altitude detail footprint', () => {
    const material = createTerrainDetailMaterialState();
    expect(TERRAIN_DETAIL_ATLAS_GRID).toBe(3);
    expect(TERRAIN_DETAIL_PAGE_SLOTS).toBe(9);
    expect(material.slots).toHaveLength(9);

    const camera = { x: 1, y: 0, z: 0 };
    const demand = [
      createTerrainTileId(0, 5, 14, 14), createTerrainTileId(0, 5, 15, 14),
      createTerrainTileId(0, 5, 16, 14), createTerrainTileId(0, 5, 17, 14),
      createTerrainTileId(0, 5, 14, 15), createTerrainTileId(0, 5, 15, 15),
      createTerrainTileId(0, 5, 16, 15), createTerrainTileId(0, 5, 17, 15),
      createTerrainTileId(0, 5, 14, 16), createTerrainTileId(0, 5, 15, 16),
      createTerrainTileId(0, 5, 16, 16), createTerrainTileId(0, 5, 17, 16),
    ];
    const pages = selectTerrainVisualPages(demand, camera, camera, 5);
    expect(pages).toHaveLength(9);
    expect(new Set(pages.map(terrainTileKey)).size).toBe(9);
  });

  it('creates a small unwrapped geographic request bound for a visual cube page', () => {
    const tile = terrainTileAtDirection({ x: 1, y: -0.02, z: 0.01 }, 12);
    const bounds = geographicBoundsForTerrainTile(tile);
    expect(bounds[0]).toBeLessThan(bounds[2]);
    expect(bounds[1]).toBeLessThan(bounds[3]);
    expect(bounds[2] - bounds[0]).toBeLessThan(0.2);
    expect(bounds[3] - bounds[1]).toBeLessThan(0.2);
  });
});
