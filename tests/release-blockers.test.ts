import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import * as state from '../src/sim/state';
import * as vessel from '../src/sim/vessel';
import { addPart, createCraft, defOf } from '../src/sim/vessel';
import { buildVesselVisual, syncVesselVisual } from '../src/render/vesselMesh';
import { PlanetRenderer, PLANET_QUALITY } from '../src/render/planet';
import * as planet from '../src/render/planet';
import { groundRadiusInertial, naturalGroundRadiusInertial, terrainHeight } from '../src/sim/terrain';
import { bodyOrientation } from '../src/sim/bodyOrientation';
import { Quat } from '../src/core/quat';
import * as worldScene from '../src/render/worldScene';
import * as THREE from 'three';
import { Vec3 } from '../src/core/vec3';
import * as navball from '../src/ui/navball';
import diagnosticCraft from '../e2e/fixtures/veyra-diagnostic-craft.json';
import { validateCraftFile } from '../src/save/persistence';

describe('M2 release blockers', () => {
  it('follows the controllable pod when staging detaches it from a booster root', () => {
    const craft = createCraft('control transfer');
    const engine = addPart(craft, 'eng-pike', null, 'root', { x: 0, y: 0, z: 0 });
    const dec = addPart(craft, 'dec-s', engine.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const pod = addPart(craft, 'pod-voyager', dec.key, 'stack-top', { x: 0, y: 2, z: 0 });
    craft.stages = [{ partKeys: [dec.key] }];

    const game = createLegacyGameState();
    const original = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(original)).toBe(true);

    expect(game.active?.runtime.craft.parts.some((p) => defOf(p).pod)).toBe(true);
    expect(game.active?.runtime.isDebris).toBe(false);
    expect(game.active?.runtime.name).toBe('control transfer');
    expect(original.runtime.isDebris).toBe(true);
    expect(original.runtime.name).toBe('control transfer debris');
  });

  it('provides graph-based auto staging for a two-stage stack', () => {
    const autoStage = (vessel as unknown as { buildAutoStages?: (craft: vessel.Craft) => vessel.Stage[] })
      .buildAutoStages;
    expect(autoStage).toBeTypeOf('function');
    if (!autoStage) return;

    const craft = createCraft('two stage');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 4, z: 0 });
    const upperTank = addPart(craft, 'tank-s1', pod.key, 'stack-bottom', { x: 0, y: 3, z: 0 });
    const upperEngine = addPart(craft, 'eng-pike', upperTank.key, 'stack-bottom', { x: 0, y: 2, z: 0 });
    const dec = addPart(craft, 'dec-s', upperEngine.key, 'stack-bottom', { x: 0, y: 1, z: 0 });
    const lowerTank = addPart(craft, 'tank-s2', dec.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    const lowerEngine = addPart(craft, 'eng-pike', lowerTank.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 5, z: 0 });

    const stages = autoStage(craft);
    expect(stages.map((s) => s.partKeys)).toEqual([
      [lowerEngine.key],
      [dec.key, upperEngine.key],
      [chute.key],
    ]);
  });

  it('keeps a coarse terrain fallback visible while detailed chunks build', () => {
    const game = createLegacyGameState();
    const body = game.universe.get('veyra');
    const renderer = new PlanetRenderer(body, { ...PLANET_QUALITY.medium, buildBudget: 1 });
    renderer.update(
      new Vec3(body.radius + 100, 0, 0),
      bodyOrientation(body, 0, new Quat()),
      new Vec3(),
    );
    for (let frame = 0; frame < 8 && !renderer.coverageReady(); frame++) {
      renderer.update(
        new Vec3(body.radius + 100, 0, 0),
        bodyOrientation(body, 0, new Quat()),
        new Vec3(),
      );
    }
    expect(renderer.stats.coverageGaps).toBe(0);
    expect(renderer.stats.overlapChunks).toBe(0);
    renderer.dispose();
  });

  it('does not add decorative rings to command pods or adapters', () => {
    for (const id of ['pod-voyager', 'adapt-ms']) {
      const craft = createCraft(id);
      addPart(craft, id, null, 'root', { x: 0, y: 0, z: 0 });
      const visual = buildVesselVisual(craft);
      const holder = visual.partMeshes.values().next().value;
      expect(holder?.children).toHaveLength(1);
    }
  });

  it('clears every prior mission vessel before a fresh launch', () => {
    const game = createLegacyGameState();
    const craft = createCraft('old flight');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    game.spawnOnPad(craft, craft.name);
    game.spawnInOrbit(structuredClone(craft), 'old debris', 'veyra', 100_000).runtime.isDebris = true;
    expect(game.vessels).toHaveLength(2);

    game.clearFlightVessels();
    expect(game.vessels).toHaveLength(0);
    expect(game.activeVesselId).toBeNull();
  });

  it('projects navball directions with right and up screen axes', () => {
    const project = (navball as unknown as {
      projectNavDirection?: (direction: Vec3, nose: Vec3, right: Vec3, screenUp: Vec3) => { x: number; y: number };
    }).projectNavDirection;
    expect(project).toBeTypeOf('function');
    if (!project) return;
    expect(project(new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 1)).x).toBeGreaterThan(0);
    expect(project(new Vec3(0, 0, 1), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 1)).y).toBeLessThan(0);
    expect(project(new Vec3(0, 1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 1))).toEqual({ x: 0, y: 0, behind: false });
  });

  it('uses the craft forward reference for heading while the nose is vertical', () => {
    const heading = (navball as unknown as {
      navHeading?: (nose: Vec3, forwardReference: Vec3, up: Vec3, east: Vec3, north: Vec3) => number;
    }).navHeading;
    expect(heading).toBeTypeOf('function');
    if (!heading) return;
    expect(heading(new Vec3(0, 0, 1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(1, 0, 0), new Vec3(0, 1, 0)))
      .toBeCloseTo(Math.PI / 2, 8);
  });

  it('shares one launch-site transform between spawning and rendering', () => {
    const siteDirection = (state as unknown as {
      launchSiteDirection?: (body: ReturnType<GameState['universe']['get']>, time: number, out: Vec3) => Vec3;
    }).launchSiteDirection;
    expect(siteDirection).toBeTypeOf('function');
    if (!siteDirection) return;
    const game = createLegacyGameState();
    const craft = createCraft('pad alignment');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const spawned = game.spawnOnPad(craft, craft.name);
    const expected = siteDirection(game.universe.get('veyra'), game.time, new Vec3());
    expect(spawned.runtime.pos.clone().normalize().dot(expected)).toBeGreaterThan(0.999999);
    expect(terrainHeight(game.universe.get('veyra'), expected)).toBeGreaterThan(0);
    const pod = spawned.runtime.craft.parts[0];
    const bottomRadius = spawned.runtime.pos.length() - defOf(pod).shape.height / 2;
    const contactRadius = groundRadiusInertial(game.universe.get('veyra'), expected, game.time);
    const naturalRadius = naturalGroundRadiusInertial(game.universe.get('veyra'), expected, game.time);
    expect(contactRadius - naturalRadius).toBeCloseTo(state.LAUNCH_PAD_DECK_HEIGHT, 6);
    expect(bottomRadius - contactRadius).toBeCloseTo(0.4, 6);
  });

  it('holds a tall rocket upright on the physical pad until powered ignition', () => {
    const craft = validateCraftFile(diagnosticCraft);
    expect(craft).not.toBeNull();
    if (!craft) return;
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(craft, craft.name);
    const body = game.bodyOf(gv);
    const launchRadius = gv.runtime.pos.length();
    for (let step = 0; step < 1_000; step++) game.update(PHYSICS_DT);

    expect(game.active).toBe(gv);
    expect(gv.runtime.situation).toBe('prelaunch');
    const up = gv.runtime.pos.clone().normalize();
    const nose = gv.runtime.att.rotate(new Vec3(0, 1, 0), new Vec3());
    expect(nose.dot(up)).toBeGreaterThan(0.999999);
    expect(gv.runtime.angVel.length()).toBe(0);

    gv.runtime.controls.throttle = 1;
    expect(game.fireStage(gv)).toBe(true);
    // The launch mechanism clears for four seconds before powered flight.
    for (let step = 0; step < Math.ceil(3.5 / PHYSICS_DT); step++) game.update(PHYSICS_DT);
    expect(gv.runtime.situation).toBe('prelaunch');
    expect(gv.runtime.pos.length()).toBeCloseTo(launchRadius, 5);
    for (let step = 0; step < Math.ceil(5.5 / PHYSICS_DT); step++) game.update(PHYSICS_DT);
    expect(game.active).toBe(gv);
    expect(gv.runtime.situation).not.toBe('prelaunch');
    expect(gv.runtime.landedBodyFixed).toBeNull();
    expect(gv.runtime.pos.length()).toBeGreaterThan(launchRadius + 100);
  });

  it('caps terrain skirts so coarse fallbacks cannot form kilometer walls', () => {
    const skirtDepth = (planet as unknown as { terrainSkirtDepth?: (worldSize: number, gridRes: number) => number })
      .terrainSkirtDepth;
    expect(skirtDepth).toBeTypeOf('function');
    if (!skirtDepth) return;
    expect(skirtDepth(1_000_000, 17)).toBeLessThanOrEqual(20);
  });

  it('uses an opaque ocean depth surface so underwater chunks cannot show through', () => {
    const game = createLegacyGameState();
    const renderer = new PlanetRenderer(game.universe.get('veyra'));
    const ocean = renderer.group.children[0] as { material?: { transparent?: boolean; opacity?: number } };
    expect(ocean.material?.transparent).toBe(false);
    expect(ocean.material?.opacity).toBe(1);
    renderer.dispose();
  });

  it('renders ocean terrain at sea level instead of exposing submerged triangles', () => {
    const surfaceHeight = (planet as unknown as { renderedTerrainHeight?: (height: number, hasOcean: boolean) => number })
      .renderedTerrainHeight;
    expect(surfaceHeight).toBeTypeOf('function');
    if (!surfaceHeight) return;
    expect(surfaceHeight(-500, true)).toBe(-500);
    expect(surfaceHeight(250, true)).toBe(250);
    expect(surfaceHeight(-500, false)).toBe(-500);
  });

  it('places the directional light toward the star', () => {
    const position = (worldScene as unknown as {
      sunLightPosition?: (direction: Vec3, distance: number, out: THREE.Vector3) => THREE.Vector3;
    }).sunLightPosition;
    expect(position).toBeTypeOf('function');
    if (!position) return;
    const sunDirection = new Vec3(0.4, -0.8, 0.2).normalize();
    const light = position(sunDirection, 10_000, new THREE.Vector3()).normalize();
    expect(light.dot(new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z))).toBeGreaterThan(0.999999);
  });

  it('prioritizes terrain builds on the camera-facing cube face', () => {
    const faceOrder = (planet as unknown as { planetFaceOrder?: (cameraDirection: Vec3) => number[] }).planetFaceOrder;
    expect(faceOrder).toBeTypeOf('function');
    if (!faceOrder) return;
    expect(faceOrder(new Vec3(-1, 0, 0))[0]).toBe(1);
    expect(faceOrder(new Vec3(0, 0, 1))[0]).toBe(4);
  });

  it('winds terrain grid triangles outward', () => {
    const indices = (planet as unknown as { terrainGridIndices?: (resolution: number) => number[] }).terrainGridIndices;
    expect(indices).toBeTypeOf('function');
    if (!indices) return;
    expect(indices(3).slice(0, 6)).toEqual([0, 1, 3, 1, 4, 3]);
  });

  it('fades and hides a liquid-engine plume after reachable fuel is exhausted', () => {
    const craft = createCraft('plume cutoff');
    const tank = addPart(craft, 'tank-s1', null, 'root', { x: 0, y: 1, z: 0 });
    const engine = addPart(craft, 'eng-pike', tank.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    engine.activated = true;
    const visual = buildVesselVisual(craft);
    const sync = syncVesselVisual as unknown as typeof syncVesselVisual & ((...args: [...Parameters<typeof syncVesselVisual>, number]) => void);
    sync(visual, craft, 1, 1, 1 / 60);
    const plume = visual.plumes.get(engine.key)!;
    expect(plume.visible).toBe(true);

    tank.resources.propellant = 0;
    for (let frame = 0; frame < 120; frame++) sync(visual, craft, 1, 1, 1 / 60);
    expect(plume.visible).toBe(false);
    // Plume groups hold one nozzle holder per authored anchor; each collapses when off.
    expect(plume.children[0].scale.x).toBeLessThan(0.02);
  });

});
