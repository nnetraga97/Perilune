import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import {
  bindFlightAerialPerspective,
  createFlightAerialMaterialVariant,
  FLIGHT_AERIAL_USER_DATA_KEY,
  FlightAerialPerspectiveController,
  flightWorldPointToBodyFixed,
} from '../src/render/flightAerialPerspective';

function body(id: 'earth' | 'moon'): Body {
  return new Body(structuredClone(SOL_SYSTEM.find((candidate) => candidate.id === id)!), null);
}

function shader() {
  return {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <worldpos_vertex>',
    fragmentShader: '#include <common>\n#include <opaque_fragment>',
  };
}

describe('per-scene flight aerial perspective', () => {
  it('reconstructs body-fixed points through multiple inverse body orientations', () => {
    const earth = body('earth');
    const camera = new THREE.Vector3(earth.radius + 10, 20, -30);
    const relative = new THREE.Vector3(4, -7, 11);
    const orientations = [
      new THREE.Quaternion(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.31, -0.72, 1.17)),
    ];
    for (const orientation of orientations) {
      const controller = new FlightAerialPerspectiveController();
      controller.update(earth, {
        cameraBodyFixed: camera,
        bodySunDirection: { x: 1, y: 0, z: 0 },
        solarVisibleFraction: 1,
        orientation,
      });
      const result = flightWorldPointToBodyFixed(
        camera,
        controller.worldToBody.value,
        relative,
      );
      const expected = relative.clone().applyQuaternion(orientation.clone().invert()).add(camera);
      expect(result.x).toBeCloseTo(expected.x, 8);
      expect(result.y).toBeCloseTo(expected.y, 8);
      expect(result.z).toBeCloseTo(expected.z, 8);
      controller.dispose();
    }
  });

  it('does not share uniforms across WorldScene controllers', () => {
    const first = new FlightAerialPerspectiveController();
    const second = new FlightAerialPerspectiveController();
    first.update(body('earth'), {
      cameraBodyFixed: { x: 1, y: 2, z: 3 },
      bodySunDirection: { x: 0, y: 1, z: 0 },
      solarVisibleFraction: 0.5,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(first.active).not.toBe(second.active);
    expect(first.aerial.cameraBodyFixed).not.toBe(second.aerial.cameraBodyFixed);
    expect(second.snapshot()).toMatchObject({ active: false, bodyId: null });
    first.dispose();
    second.dispose();
  });

  it('chains existing shader hooks and injects exactly once at stable anchors', () => {
    const controller = new FlightAerialPerspectiveController();
    const base = new THREE.MeshStandardMaterial();
    const previousCompile = vi.fn((program: { fragmentShader: string }) => {
      program.fragmentShader = program.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nfloat existingHook = 1.0;',
      );
    });
    base.onBeforeCompile = previousCompile as never;
    base.customProgramCacheKey = () => 'existing-program';
    const variant = createFlightAerialMaterialVariant(base, controller);
    bindFlightAerialPerspective(variant, controller);
    const program = shader();
    variant.onBeforeCompile(program as never, {} as THREE.WebGLRenderer);
    expect(previousCompile).toHaveBeenCalledOnce();
    expect(program.fragmentShader).toContain('existingHook');
    expect(program.fragmentShader).toContain('flightAerialWorldToBody * vFlightAerialWorldPosition');
    expect(program.fragmentShader.match(/applyTerrestrialAerialPerspective\(/g)).toHaveLength(2);
    expect(program.vertexShader.match(/vFlightAerialWorldPosition = flightAerialWorldPosition4\.xyz/g))
      .toHaveLength(1);
    expect(variant.customProgramCacheKey()).toBe('existing-program:flight-aerial-v1');
    base.dispose();
    variant.dispose();
    controller.dispose();
  });

  it('clones material state while leaving base hooks and borrowed textures untouched', () => {
    const controller = new FlightAerialPerspectiveController();
    const texture = new THREE.Texture();
    const base = new THREE.MeshStandardMaterial({ map: texture, color: '#abcdef' });
    const baseCompile = base.onBeforeCompile;
    const variant = createFlightAerialMaterialVariant(base, controller);
    expect(variant).not.toBe(base);
    expect(variant.map).toBe(texture);
    expect(variant.color.getHex()).toBe(base.color.getHex());
    expect(base.onBeforeCompile).toBe(baseCompile);
    expect(base.userData[FLIGHT_AERIAL_USER_DATA_KEY]).toBeUndefined();
    expect(variant.userData[FLIGHT_AERIAL_USER_DATA_KEY]).toBe(controller);
    const textureDispose = vi.spyOn(texture, 'dispose');
    variant.dispose();
    expect(textureDispose).not.toHaveBeenCalled();
    base.dispose();
    texture.dispose();
    controller.dispose();
  });

  it('enables Earth haze and strictly disables it on the Moon', () => {
    const controller = new FlightAerialPerspectiveController();
    const earth = body('earth');
    const moon = body('moon');
    const frame = {
      cameraBodyFixed: { x: earth.radius + 10, y: 0, z: 0 },
      bodySunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 1,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
    controller.update(earth, frame);
    expect(controller.snapshot()).toMatchObject({ active: true, bodyId: 'earth' });
    expect(controller.aerial.atmosphereHeight.value).toBe(100_000);
    controller.disable(moon, {
      ...frame,
      cameraBodyFixed: { x: moon.radius + 10, y: 0, z: 0 },
    });
    expect(controller.snapshot()).toMatchObject({ active: false, bodyId: 'moon' });
    expect(controller.aerial.atmosphereHeight.value).toBe(0);
    expect(controller.aerial.useLookup.value).toBe(0);
    controller.dispose();
  });
});
