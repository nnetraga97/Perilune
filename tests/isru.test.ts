import { createLegacyGameState, restoreLegacyGame, migrateLegacySave } from './fixtures/legacyGameState';
/**
 * ISRU chain: orbital resource scan → surface drilling → ore-to-propellant
 * conversion, including background processing under rails warp and save
 * round-trip of scan state.
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft, Craft, defOf } from '../src/sim/vessel';
import { oreConcentration, depositSites, oreCapacityOf } from '../src/sim/resources';
import { RESOURCE_DENSITY, partById } from '../src/content/parts';
import { serializeGame, restoreGame } from '../src/save/persistence';
import { migrateSave, SAVE_VERSION } from '../src/save/schema';
import type { GameVessel } from '../src/sim/state';

function buildMiner(): Craft {
  const craft = createCraft('Miner');
  const plate = addPart(craft, 'plate-base', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'core-pilot', plate.key, 'stack-top', { x: 0, y: 0.2, z: 0 });
  addPart(craft, 'drill-auger', plate.key, 'surface', { x: 0.9, y: 0, z: 0 });
  addPart(craft, 'bin-ore', plate.key, 'stack-bottom', { x: 0, y: -0.6, z: 0 });
  addPart(craft, 'conv-kiln', plate.key, 'surface', { x: -1.2, y: 0.4, z: 0 });
  addPart(craft, 'tank-s1', plate.key, 'surface', { x: 0, y: 0.4, z: -1.2 });
  addPart(craft, 'solar-fold', plate.key, 'surface', { x: 0, y: 0.4, z: 1.2 });
  addPart(craft, 'batt-m', plate.key, 'surface', { x: 0.5, y: 0.4, z: 0.8 });
  return craft;
}

function buildScanner(): Craft {
  const craft = createCraft('Surveyor');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'scan-prospector', core.key, 'stack-bottom', { x: 0, y: -0.35, z: 0 });
  addPart(craft, 'solar-fold', core.key, 'surface', { x: 0.4, y: 0, z: 0 });
  return craft;
}

function findPart(gv: GameVessel, defId: string) {
  return gv.runtime.craft.parts.find((p) => p.defId === defId)!;
}

describe('ore field', () => {
  it('is deterministic, bounded, and varies over the surface', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = i / 200;
      const dir = new Vec3(
        Math.cos(t * 12) * Math.cos(t * 3),
        Math.sin(t * 12) * Math.cos(t * 3),
        Math.sin(t * 3),
      ).normalize();
      const c = oreConcentration(veyra, dir);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBe(oreConcentration(veyra, dir)); // deterministic
      samples.push(c);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min).toBeGreaterThan(0.15); // real variation

    // Gas giants have no minable surface.
    const tyran = game.universe.get('tyran');
    expect(oreConcentration(tyran, new Vec3(1, 0, 0))).toBe(0);
  });

  it('finds distinct rich deposit sites', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const sites = depositSites(veyra, 6);
    expect(sites.length).toBeGreaterThan(2);
    for (const s of sites) {
      expect(s.concentration).toBeGreaterThan(0.5);
      expect(Math.abs(s.dir.length() - 1)).toBeLessThan(1e-9);
    }
    // Sites are angularly separated.
    for (let i = 0; i < sites.length; i++) {
      for (let j = i + 1; j < sites.length; j++) {
        expect(sites[i].dir.dot(sites[j].dir)).toBeLessThan(0.95);
      }
    }
  });
});

describe('orbital scanning', () => {
  it('scans from orbit with a scanner; refuses without one or when landed', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildScanner(), 'Surveyor', 'veyra', 120_000);
    expect(game.scannedBodies.has('veyra')).toBe(false);
    const res = game.performScan(gv);
    expect(res.ok, res.reason).toBe(true);
    expect(game.scannedBodies.has('veyra')).toBe(true);

    // No scanner aboard → refuse.
    const game2 = createLegacyGameState();
    const bare = game2.spawnInOrbit(buildMiner(), 'Miner', 'veyra', 120_000);
    expect(game2.performScan(bare).ok).toBe(false);

    // Landed → refuse.
    const game3 = createLegacyGameState();
    const grounded = game3.spawnOnPad(buildScanner(), 'Grounded');
    expect(game3.performScan(grounded).ok).toBe(false);
  });
});

describe('drilling', () => {
  it('extracts ore while landed, fills bins toward capacity, and needs charge', () => {
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(buildMiner(), 'Miner');
    const drill = findPart(gv, 'drill-auger');
    const bin = findPart(gv, 'bin-ore');
    expect(bin.resources.ore ?? 0).toBe(0); // bins start empty
    expect(oreCapacityOf(defOf(bin))).toBeGreaterThan(0);

    // Not activated → nothing happens.
    for (let i = 0; i < 250; i++) game.update(PHYSICS_DT);
    expect(bin.resources.ore ?? 0).toBe(0);

    // Activate and drill for 60 s of game time.
    drill.activated = true;
    for (let i = 0; i < 3000; i++) game.update(PHYSICS_DT);
    const mined = bin.resources.ore ?? 0;
    expect(mined).toBeGreaterThan(1);

    // Without charge the drill stalls.
    gv.runtime.charge.amount = 0;
    // Remove the solar panel so it cannot recharge.
    gv.runtime.craft.parts = gv.runtime.craft.parts.filter((p) => p.defId !== 'solar-fold');
    const before = bin.resources.ore ?? 0;
    for (let i = 0; i < 500; i++) game.update(PHYSICS_DT);
    expect((bin.resources.ore ?? 0) - before).toBeLessThan(0.05);
  });

  it('keeps mining in the background under rails warp and stops at capacity', () => {
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(buildMiner(), 'Miner');
    const drill = findPart(gv, 'bin-ore');
    void drill;
    findPart(gv, 'drill-auger').activated = true;
    // Settle onto the pad until firmly landed.
    for (let i = 0; i < 1000 && gv.runtime.situation !== 'landed'; i++) {
      game.update(PHYSICS_DT);
    }
    expect(['landed', 'prelaunch']).toContain(gv.runtime.situation);

    // Rails warp hard: hours of game time in a few frames.
    game.setWarp(4, true); // 1000×
    expect(game.railsWarp).toBe(true);
    for (let i = 0; i < 400; i++) game.update(0.1); // 40 000 s of sim time
    const bin = findPart(gv, 'bin-ore');
    const cap = oreCapacityOf(defOf(bin));
    expect(bin.resources.ore ?? 0).toBeGreaterThan(cap * 0.5);
    expect(bin.resources.ore ?? 0).toBeLessThanOrEqual(cap + 1e-6);
  });
});

describe('conversion', () => {
  it('refines ore into propellant with the documented yield and stops when done', () => {
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(buildMiner(), 'Miner');
    const bin = findPart(gv, 'bin-ore');
    const tank = findPart(gv, 'tank-s1');
    const kiln = findPart(gv, 'conv-kiln');
    bin.resources.ore = 60;
    tank.resources.propellant = 0;

    kiln.activated = true;
    for (let i = 0; i < 50; i++) game.update(PHYSICS_DT);
    const oreMid = bin.resources.ore ?? 0;
    const propMid = tank.resources.propellant ?? 0;
    expect(oreMid).toBeLessThan(60);
    expect(propMid).toBeGreaterThan(0);
    expect(game.flags['campaign:surface-industry']).toBe(true);
    // Yield: propellant units = ore units × yield × densityRatio.
    const kilnDef = partById('conv-kiln').converter!;
    const expectedRatio = kilnDef.yield * (RESOURCE_DENSITY.ore / RESOURCE_DENSITY.propellant);
    expect(propMid / (60 - oreMid)).toBeCloseTo(expectedRatio, 1);

    // Run to exhaustion (rails warp background).
    game.setWarp(4, true);
    for (let i = 0; i < 100; i++) game.update(0.1);
    expect(bin.resources.ore ?? 0).toBeLessThan(0.01);
    const propEnd = tank.resources.propellant ?? 0;
    expect(propEnd).toBeLessThanOrEqual(180 + 1e-6); // tank capacity respected
    expect(propEnd / 60).toBeCloseTo(expectedRatio, 1);
  });
});

describe('ISRU persistence', () => {
  it('round-trips scan state and migrates v1 saves', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(buildScanner(), 'Surveyor', 'veyra', 120_000);
    expect(game.performScan(gv).ok).toBe(true);

    const save = serializeGame(game, 'isru-test');
    expect(save.saveVersion).toBe(SAVE_VERSION);
    const restored = restoreLegacyGame(JSON.parse(JSON.stringify(save)));
    expect(restored.scannedBodies.has('veyra')).toBe(true);

    // A v1 save (no isru block) must migrate cleanly with empty scan state.
    const v1 = JSON.parse(JSON.stringify(save));
    v1.saveVersion = 1;
    delete v1.isru;
    const migrated = migrateLegacySave(v1);
    expect(migrated.saveVersion).toBe(SAVE_VERSION);
    expect(migrated.isru?.scanned ?? []).toEqual([]);
  });
});
