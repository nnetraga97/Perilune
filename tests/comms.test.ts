import { createLegacyGameState } from './fixtures/legacyGameState';
/**
 * Communications network: range limits, planetary occlusion, and relay
 * routing (acceptance scenario 11: control a probe through a relay).
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import { addPart, createCraft, Craft } from '../src/sim/vessel';
import { evaluateComms, needsCommsForControl, segmentBlocked } from '../src/sim/comms';

function probeCraft(antenna: 'ant-whip' | 'ant-wayline' | 'ant-dish' | null): Craft {
  const craft = createCraft('Probe');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  if (antenna) addPart(craft, antenna, core.key, 'surface', { x: 0.5, y: 0, z: 0 });
  addPart(craft, 'solar-flat', core.key, 'surface', { x: -0.5, y: 0, z: 0 });
  return craft;
}

describe('comms network', () => {
  it('uses the launch-site authority for the Cape Skyward ground station', () => {
    const game = createLegacyGameState();
    const gv = game.spawnOnPad(probeCraft('ant-whip'), 'Pad Probe');
    const status = evaluateComms(game, gv);
    expect(status.connected).toBe(true);
    expect(status.path.at(-1)).toBe('Cape Skyward');
  });

  it('connects a whip-antenna probe in low orbit to the ground', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(probeCraft('ant-whip'), 'LEO Probe', 'veyra', 200_000);
    const status = evaluateComms(game, gv);
    expect(status.connected).toBe(true);
    expect(status.path.length).toBeGreaterThanOrEqual(2);
    expect(status.strength).toBeGreaterThan(0.2);
    expect(needsCommsForControl(gv)).toBe(true);
  });

  it('loses signal without an antenna', () => {
    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(probeCraft(null), 'Mute Probe', 'veyra', 200_000);
    const status = evaluateComms(game, gv);
    expect(status.connected).toBe(false);
  });

  it('uses the Wayline tier for neighboring interplanetary missions', () => {
    const game = createLegacyGameState();
    const target = game.spawnInOrbit(probeCraft('ant-wayline'), 'Vess Probe', 'vess', 200_000);
    const body = game.universe.get('vess');
    const towardHome = new Vec3();
    game.universe.relativePosition(game.universe.get('veyra'), body, game.time, towardHome);
    target.runtime.pos.copy(towardHome.normalize()).scale(body.radius + 200_000);

    expect(evaluateComms(game, target).connected).toBe(true);
  });

  it('lets the Longtalk tier reach the far system without a mandatory range relay', () => {
    const game = createLegacyGameState();
    const target = game.spawnInOrbit(probeCraft('ant-dish'), 'Farfall Probe', 'farfall', 200_000);
    const body = game.universe.get('farfall');
    const towardHome = new Vec3();
    game.universe.relativePosition(game.universe.get('veyra'), body, game.time, towardHome);
    target.runtime.pos.copy(towardHome.normalize()).scale(body.radius + 200_000);

    expect(evaluateComms(game, target).connected).toBe(true);
  });

  it('is blocked behind Palla and restored via a relay', () => {
    const game = createLegacyGameState();
    // Probe on the far side of Palla (from Veyra).
    const probe = game.spawnInOrbit(probeCraft('ant-whip'), 'Farside Probe', 'palla', 30_000);
    const palla = game.universe.get('palla');
    // Position the probe on the anti-Veyra side: Palla's position relative
    // to Veyra is P; put the probe along +P direction from Palla's center.
    const pallaPos = new Vec3();
    game.universe.localPosition(palla, game.time, pallaPos);
    const outDir = pallaPos.clone().normalize();
    probe.runtime.pos.copy(outDir).scale(palla.radius + 30_000);
    // Velocity roughly perpendicular for a sane orbit (not important here).
    probe.runtime.vel.set(-outDir.y, outDir.x, 0).scale(Math.sqrt(palla.mu / probe.runtime.pos.length()));

    const blocked = evaluateComms(game, probe);
    expect(blocked.connected, 'probe should be occluded by Palla').toBe(false);

    // Add a relay high above Palla with line of sight to both.
    const relay = game.spawnInOrbit(probeCraft('ant-dish'), 'Palla Relay', 'palla', 2_000_000 * 0.4);
    // Put the relay off to the side: visible from both the probe and Veyra.
    relay.runtime.pos.set(outDir.x, outDir.y, 0).normalize();
    relay.runtime.pos.set(
      outDir.x * 0.4 - outDir.y * 0.9,
      outDir.y * 0.4 + outDir.x * 0.9,
      0.15,
    ).normalize().scale(palla.radius + 800_000);

    game.activeVesselId = probe.runtime.id;
    const relayed = evaluateComms(game, probe);
    expect(relayed.connected, 'relay should restore the link').toBe(true);
    expect(relayed.path).toContain('Palla Relay');
  });

  it('segment occlusion math blocks through-planet paths', () => {
    const game = createLegacyGameState();
    const veyra = game.universe.get('veyra');
    const vp = new Vec3();
    game.universe.absolutePosition(veyra, 0, vp);
    const a = vp.clone().add(new Vec3(2e6, 0, 0));
    const b = vp.clone().add(new Vec3(-2e6, 0, 0));
    expect(segmentBlocked(game, a, b)).toBe(true); // straight through the planet
    const c = vp.clone().add(new Vec3(2e6, 2e6, 0));
    const d = vp.clone().add(new Vec3(-2e6, 2e6, 0));
    expect(segmentBlocked(game, c, d)).toBe(false); // passes well clear
  });
});
