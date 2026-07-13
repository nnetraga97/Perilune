import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameState } from '../src/sim/state';
import { TerrestrialCloudDeck } from '../src/render/terrestrial/cloudLayer';
import { RenderDiagnostics } from '../src/render/renderDiagnostics';

const universe = new GameState().universe;
const veyra = universe.get('veyra');

function cloudTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([180, 210, 0, 255]), 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

const frame = {
  cameraRelativeOrigin: { x: 10, y: 20, z: 30 },
  orientation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.37),
  bodySunDirection: { x: 0, y: 3, z: 0 },
  time: 12_345,
  altitude: 1_000,
};

describe('Veyra two-scale clouds', () => {
  it('records static shell facts and dynamic crossing classifications for both shells', () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => now++ });
    const texture = cloudTexture();
    const deck = new TerrestrialCloudDeck(veyra, 'high', texture, diagnostics);
    const weather = deck.shells[0];
    const wisps = deck.shells[1];
    deck.update({ ...frame, altitude: weather.altitude - 6_000 });
    now += 100;
    deck.update({ ...frame, altitude: weather.altitude });
    now += 100;
    deck.update({ ...frame, altitude: wisps.altitude + 6_000 });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.entries.filter((entry) => entry.event === 'cloud-shell-created')).toHaveLength(2);
    expect(snapshot.entries.find((entry) => entry.event === 'cloud-shell-created' && entry.data.shell === 'weather')?.data)
      .toMatchObject({ widthSegments: 96, heightSegments: 60, textureIdentity: texture.uuid, shadowMaterial: true });
    expect(snapshot.entries.filter((entry) => entry.event === 'cloud-shell-sample').map((entry) => entry.data.classification))
      .toEqual(expect.arrayContaining(['inside', 'crossing', 'outside']));
    deck.dispose();
    expect(diagnostics.snapshot().entries.filter((entry) => entry.event === 'cloud-shell-disposed')).toHaveLength(2);
  });

  it('owns two shells with distinct altitude, scale, and drift rates', () => {
    const deck = new TerrestrialCloudDeck(veyra, 'medium', cloudTexture());
    expect(deck.shells.map((shell) => shell.name)).toEqual(['weather', 'wisps']);
    expect(deck.shells[0].altitude).not.toBe(deck.shells[1].altitude);
    expect(deck.shells[0].driftRate).not.toBe(deck.shells[1].driftRate);
    expect(deck.shells[0].mesh.material.uniforms.uTextureScale.value).toBe(1);
    expect(deck.shells[1].mesh.material.uniforms.uTextureScale.value).toBe(3);
    deck.dispose();
  });

  it('composes authoritative orientation before drift and keeps simulation quality-independent', () => {
    const low = new TerrestrialCloudDeck(veyra, 'low', cloudTexture());
    const high = new TerrestrialCloudDeck(veyra, 'high', cloudTexture());
    low.update(frame);
    high.update(frame);
    const expectedDrift = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      frame.time * low.shells[0].driftRate,
    );
    const expected = frame.orientation.clone().multiply(expectedDrift);
    expect(low.shells[0].mesh.quaternion.angleTo(expected)).toBeLessThan(1e-12);
    expect(low.shells[0].mesh.quaternion.angleTo(high.shells[0].mesh.quaternion)).toBeLessThan(1e-12);
    expect(low.group.position.toArray()).toEqual([10, 20, 30]);
    expect((low.shells[0].mesh.material.uniforms.uSunDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
    low.dispose();
    high.dispose();
  });

  it('disables Low shadows and gives only the weather shell an alpha-aware conditional shadow', () => {
    const low = new TerrestrialCloudDeck(veyra, 'low', cloudTexture());
    const medium = new TerrestrialCloudDeck(veyra, 'medium', cloudTexture());
    expect(low.shells.every((shell) => !shell.mesh.castShadow)).toBe(true);
    expect(low.shells[0].mesh.customDepthMaterial).toBeUndefined();
    expect(medium.shells[0].mesh.castShadow).toBe(true);
    expect(medium.shells[0].mesh.customDepthMaterial).toBeInstanceOf(THREE.ShaderMaterial);
    expect(medium.shells[1].mesh.castShadow).toBe(false);
    medium.setShadowEnabled(false);
    expect(medium.shells[0].mesh.castShadow).toBe(false);
    medium.setShadowEnabled(true);
    expect(medium.shells[0].mesh.castShadow).toBe(true);
    expect(medium.group.children.some((child) => child instanceof THREE.DirectionalLight)).toBe(false);
    low.dispose();
    medium.dispose();
  });

  it('uses one shell face, fades through crossings, and orders transparent shells outside-in', () => {
    const deck = new TerrestrialCloudDeck(veyra, 'medium', cloudTexture());
    const weather = deck.shells[0];
    const wisps = deck.shells[1];
    expect(wisps.mesh.renderOrder).toBeLessThan(weather.mesh.renderOrder);
    expect(weather.mesh.material.uniforms.uOpacity.value).toBeLessThanOrEqual(0.5);
    expect(wisps.mesh.material.uniforms.uOpacity.value).toBeLessThanOrEqual(0.25);

    deck.update({ ...frame, altitude: weather.altitude - 5_000 });
    expect(weather.mesh.material.side).toBe(THREE.BackSide);
    deck.update({ ...frame, altitude: weather.altitude });
    expect(weather.mesh.material.uniforms.uOpacity.value).toBe(0);
    deck.update({ ...frame, altitude: weather.altitude + 5_000 });
    expect(weather.mesh.material.side).toBe(THREE.FrontSide);
    expect(weather.mesh.material.uniforms.uOpacity.value).toBeGreaterThan(0);
    deck.dispose();
  });

  it('disposes owned geometry/materials once without disposing the borrowed cloud texture', () => {
    const texture = cloudTexture();
    const textureDispose = vi.spyOn(texture, 'dispose');
    const deck = new TerrestrialCloudDeck(veyra, 'medium', texture);
    const geometryDisposals = deck.shells.map((shell) => vi.spyOn(shell.mesh.geometry, 'dispose'));
    const materialDisposals = deck.shells.map((shell) => vi.spyOn(shell.mesh.material, 'dispose'));
    const depthDispose = vi.spyOn(deck.shells[0].mesh.customDepthMaterial!, 'dispose');
    deck.dispose();
    deck.dispose();
    for (const dispose of geometryDisposals) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of materialDisposals) expect(dispose).toHaveBeenCalledOnce();
    expect(depthDispose).toHaveBeenCalledOnce();
    expect(textureDispose).not.toHaveBeenCalled();
  });

  it('rejects airless bodies', () => {
    expect(() => new TerrestrialCloudDeck(universe.get('palla'), 'low', cloudTexture()))
      .toThrow(/no atmosphere for clouds/i);
  });
});
