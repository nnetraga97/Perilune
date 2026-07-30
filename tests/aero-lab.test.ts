import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';
import {
  evaluateAeroLab,
  resolveAeroLabEnvironment,
} from '../src/sim/aeroLab';
import { analyzeAeroLabField } from '../src/render/aeroLabAnalysis';
import { aeroLabFingerprint, buildAeroLabSurface } from '../src/render/aeroLabGeometry';
import { buildAeroModel } from '../src/sim/aero';
import { evaluateThermalExposure } from '../src/sim/aeroThermalExposure';

function testCraft() {
  const craft = createCraft('Wind tunnel article');
  const tank = addPart(craft, 'tank-s2', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'pod-voyager', tank.key, 'stack-top', { x: 0, y: 1.6, z: 0 });
  return craft;
}

function tankStack(count: number) {
  const craft = createCraft(`${count}-tank stack`);
  let parentKey: number | null = null;
  for (let index = 0; index < count; index++) {
    const tank = addPart(craft, 'tank-s2', parentKey, index === 0 ? 'root' : 'stack-top', {
      x: 0,
      y: index * 1.8,
      z: 0,
    });
    parentKey = tank.key;
  }
  return craft;
}

describe('Aerodynamics Lab', () => {
  it('resolves editor vacuum tokens to the same body above its atmosphere', () => {
    const game = new GameState();
    const seaLevel = resolveAeroLabEnvironment(game.universe, 'earth-sl');
    const vacuum = resolveAeroLabEnvironment(game.universe, 'earth-vac');

    expect(vacuum.body).toBe(seaLevel.body);
    expect(vacuum.altitude).toBe(seaLevel.body.def.atmosphere?.height);
    expect(vacuum.body.densityAt(vacuum.altitude)).toBe(0);
  });

  it('uses the flight aero model for dynamic pressure and vacuum output', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const craft = testCraft();
    const atmospheric = evaluateAeroLab(craft, earth, {
      altitude: 0,
      mach: 0.5,
      orientationDeg: 0,
    });
    expect(atmospheric.dynamicPressure).toBeCloseTo(
      0.5 * earth.densityAt(0) * atmospheric.speed * atmospheric.speed,
      8,
    );
    expect(atmospheric.drag).toBeGreaterThan(0);

    const vacuum = evaluateAeroLab(craft, earth, {
      altitude: earth.def.atmosphere!.height,
      mach: 1,
      orientationDeg: 0,
    });
    expect(vacuum.dynamicPressure).toBe(0);
    expect(vacuum.drag).toBe(0);
    expect(vacuum.heatFlux).toBe(0);
  });

  it('characterizes the flight model across speed, Mach boundaries, and orientation', () => {
    const earth = new GameState().universe.get('earth');
    const craft = testCraft();
    const read = (mach: number, orientationDeg = 0) => evaluateAeroLab(craft, earth, {
      altitude: 0,
      mach,
      orientationDeg,
    });
    expect(read(0.6).dynamicPressure).toBeGreaterThan(read(0.3).dynamicPressure);
    for (const [below, above] of [[0.799, 0.801], [1.199, 1.201]]) {
      const left = read(below).drag;
      const right = read(above).drag;
      expect(Math.abs(right - left) / Math.max(left, right)).toBeLessThan(0.05);
    }
    expect(read(0.5, 180).drag).toBeCloseTo(read(0.5, 0).drag, 8);
    expect(read(0.5, 90).modelAoaDeg).toBeCloseTo(90, 8);
  });

  it('invalidates the analysis fingerprint when a part transform changes', () => {
    const craft = testCraft();
    const before = aeroLabFingerprint(craft);
    craft.parts[0].position.x += 0.25;
    expect(aeroLabFingerprint(craft)).not.toBe(before);
    const moved = aeroLabFingerprint(craft);
    craft.parts[0].rotation.z += 0.1;
    expect(aeroLabFingerprint(craft)).not.toBe(moved);
  });

  it('removes flush buried caps without erasing exposed tank triangles', () => {
    const singleSurface = buildAeroLabSurface(tankStack(1));
    const singleResult = analyzeAeroLabField({
      surface: singleSurface,
      flowDirection: [0, -1, 0],
      mach: 0.5,
      quality: 'low',
    });
    expect(singleResult.positions.length).toBe(singleSurface.positions.length);

    let capTriangles = 0;
    for (let index = 0; index < singleSurface.positions.length; index += 9) {
      const centerY = (singleSurface.positions[index + 1]
        + singleSurface.positions[index + 4]
        + singleSurface.positions[index + 7]) / 3;
      if (Math.abs(centerY - 0.9) < 1e-5) capTriangles++;
    }

    const stackedSurface = buildAeroLabSurface(tankStack(2));
    const stackedResult = analyzeAeroLabField({
      surface: stackedSurface,
      flowDirection: [0, -1, 0],
      mach: 0.5,
      quality: 'low',
    });
    expect(stackedResult.positions.length).toBe(stackedSurface.positions.length - capTriangles * 2 * 9);
    for (let index = 0; index < stackedResult.positions.length; index += 9) {
      const centerY = (stackedResult.positions[index + 1]
        + stackedResult.positions[index + 4]
        + stackedResult.positions[index + 7]) / 3;
      expect(Math.abs(centerY - 0.9)).toBeGreaterThan(1e-5);
    }
  });

  it('shares the flight axial heat-shield exposure model', () => {
    const craft = createCraft('Shielded article');
    const shield = addPart(craft, 'shield-s', null, 'root', { x: 0, y: -1, z: 0 });
    const tank = addPart(craft, 'tank-s2', shield.key, 'stack-top', { x: 0, y: 0.5, z: 0 });
    const exposure = evaluateThermalExposure(craft, buildAeroModel(craft), -1);
    expect(exposure.get(shield.key)).toBeGreaterThan(exposure.get(tank.key)!);
    expect(exposure.get(tank.key)).toBeLessThan(0.1);
  });

  it('produces finite, surface-terminated streamline data within a bounded budget', () => {
    const surface = buildAeroLabSurface(testCraft());
    const result = analyzeAeroLabField({
      surface,
      flowDirection: [0, -1, 0],
      mach: 0.5,
      quality: 'low',
    });
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeLessThanOrEqual(surface.positions.length);
    expect(result.streamlineOffsets.length).toBe(25);
    expect([...result.streamlinePositions].every(Number.isFinite)).toBe(true);
    expect(result.streamlinePositions.byteLength + result.positions.byteLength).toBeLessThan(2 * 1024 * 1024);
  });

  it('separates upstream and downstream lines in supersonic flow', () => {
    const craft = tankStack(5);
    const top = craft.parts[craft.parts.length - 1];
    addPart(craft, 'pod-voyager', top.key, 'stack-top', { x: 0, y: 9, z: 0 });
    const surface = buildAeroLabSurface(craft);
    const result = analyzeAeroLabField({
      surface,
      flowDirection: [0, -1, 0],
      mach: 2,
      quality: 'low',
    });
    expect(result.streamlineOffsets.length).toBe(49);
    const ys = Array.from({ length: surface.positions.length / 3 }, (_, index) => surface.positions[index * 3 + 1]);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (let line = 0; line < 24; line++) {
      const lastPoint = result.streamlineOffsets[line + 1] - 1;
      expect(result.streamlinePositions[lastPoint * 3 + 1]).toBeGreaterThan(maxY);
    }
    for (let line = 24; line < 48; line++) {
      const firstPoint = result.streamlineOffsets[line];
      expect(result.streamlinePositions[firstPoint * 3 + 1]).toBeLessThan(minY);
    }
  });
});
