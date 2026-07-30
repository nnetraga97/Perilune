import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWayfarerDemonstrator } from '../src/content/crafts';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { buildAeroModel } from '../src/sim/aero';
import { ActiveReentryEffect } from '../src/render/reentryEffects';

describe('active reentry visual stack', () => {
  it('gates all four passes from one signal and remains one active-vessel group', () => {
    const craft = createWayfarerDemonstrator();
    const effect = new ActiveReentryEffect(craft, buildAeroModel(craft).axialFrac, 'medium', BODY_VISUALS.veyra.entryVisual!);
    expect(effect.group.children.map((child) => child.name)).toEqual([
      'reentry-glow',
      'reentry-trails',
      'reentry-bowshock-bowl',
      'reentry-bowshock-wisps',
      'reentry-sparks',
    ]);
    expect(effect.stats()).toMatchObject({ active: false, glow: false, trails: false, bowshock: false });
    const input = {
      velocityOS: new THREE.Vector3(0, 1, 0),
      flowAlign: 1,
      signal: { strength: 1, transonic: 0 },
      time: 10,
      wallDeltaSeconds: 1 / 30,
    };
    effect.update(input);
    effect.update({ ...input, time: 10 + 1 / 30 });
    expect(effect.stats()).toMatchObject({ active: true, glow: true, trails: true, bowshock: true });
    expect(effect.stats().particles).toBeGreaterThan(0);
    const points = effect.group.children[4] as THREE.Points;
    const positions = points.geometry.getAttribute('position');
    const life = points.geometry.getAttribute('aLife');
    let alive = 0;
    for (let index = 0; index < positions.count; index++) {
      const position = [positions.getX(index), positions.getY(index), positions.getZ(index)];
      if (life.getX(index) > 0) {
        alive++;
        expect(position).not.toEqual([0, 0, 0]);
      } else {
        expect(position).toEqual([0, 0, 0]);
      }
    }
    expect(alive).toBe(effect.stats().particles);
    expect((points.material as THREE.ShaderMaterial).fragmentShader).toContain('if (vLife <= 0.0) discard;');
    effect.update({ ...input, reducedMotion: true });
    expect(points.visible).toBe(false);
    expect(Array.from((points.geometry.getAttribute('aLife') as THREE.BufferAttribute).array)).toEqual(
      Array.from({ length: positions.count }, () => 0),
    );
    expect(Array.from((points.geometry.getAttribute('position') as THREE.BufferAttribute).array)).toEqual(
      Array.from({ length: positions.count * 3 }, () => 0),
    );
    effect.dispose();
  });

  it('keeps log-depth shader dependencies complete and low tier depth-pass-free', () => {
    const craft = createWayfarerDemonstrator();
    const effect = new ActiveReentryEffect(craft, buildAeroModel(craft).axialFrac, 'low', BODY_VISUALS.veyra.entryVisual!);
    const shaders: string[] = [];
    effect.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
      const material = object.material;
      if (material instanceof THREE.ShaderMaterial) shaders.push(material.vertexShader);
    });
    expect(shaders).toHaveLength(5);
    for (const shader of shaders) {
      expect(shader).toContain('#include <common>');
      expect(shader).toContain('#include <logdepthbuf_vertex>');
    }
    expect(effect.stats().occlusion).toBe(false);
    effect.dispose();
  });

  it('scales trail and bowshock shaders to the craft envelope', () => {
    const craft = createWayfarerDemonstrator();
    const effect = new ActiveReentryEffect(craft, buildAeroModel(craft).axialFrac, 'medium', BODY_VISUALS.veyra.entryVisual!);
    const materials: THREE.ShaderMaterial[] = [];
    effect.group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial) materials.push(object.material);
    });
    expect(materials.every((material) => material.uniforms.uCraftRadius.value > 1)).toBe(true);
    expect(materials.some((material) => material.vertexShader.includes('uLength * uCraftRadius'))).toBe(true);
    effect.dispose();
  });
});
