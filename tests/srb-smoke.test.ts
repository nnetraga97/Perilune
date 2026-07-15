import { describe, expect, it } from 'vitest';
import { SrbSmokePool } from '../src/render/srbSmoke';

const origin = { x: 0, y: 0, z: 0 };
const down = { x: 0, y: -1, z: 0 };
const up = { x: 0, y: 1, z: 0 };

describe('SrbSmokePool', () => {
  it('does not emit smoke in vacuum', () => {
    const pool = new SrbSmokePool('medium');
    pool.beginFrame(1 / 60, origin);
    pool.emit({
      emitterId: 'v:1:0',
      position: origin,
      direction: down,
      inheritedVelocity: origin,
      up,
      pressureFrac: 0,
      plumeScale: 1,
    });
    pool.endFrame();
    expect(pool.particleCount()).toBe(0);
    pool.dispose();
  });

  it('keeps Medium smoke bounded and camera-relative data finite', () => {
    const pool = new SrbSmokePool('medium');
    for (let frame = 0; frame < 900; frame++) {
      pool.beginFrame(1 / 60, { x: frame * 3, y: 4e8, z: -2e8 });
      for (let motor = 0; motor < 8; motor++) {
        pool.emit({
          emitterId: `v:${motor}:0`,
          position: { x: frame * 3, y: 4e8, z: -2e8 },
          direction: down,
          inheritedVelocity: { x: 180, y: 0, z: 0 },
          up,
          pressureFrac: 1,
          plumeScale: 1.7,
        });
      }
      pool.endFrame();
      expect(pool.particleCount()).toBeLessThanOrEqual(1024);
    }
    const positions = pool.points.geometry.getAttribute('position').array;
    for (let index = 0; index < pool.particleCount() * 3; index++) {
      expect(Number.isFinite(positions[index])).toBe(true);
    }
    pool.dispose();
  });

  it('preserves inherited root-frame velocity under a moving camera', () => {
    const pool = new SrbSmokePool('medium');
    const inheritedSpeed = 30_000;
    pool.beginFrame(1 / 60, origin);
    pool.emit({
      emitterId: 'orbital:v:0',
      position: origin,
      direction: down,
      inheritedVelocity: { x: inheritedSpeed, y: 0, z: 0 },
      up,
      pressureFrac: 1,
      plumeScale: 1,
    });
    pool.endFrame();

    for (let frame = 1; frame <= 60; frame++) {
      pool.beginFrame(1 / 60, { x: inheritedSpeed * frame / 60, y: 0, z: 0 });
      pool.endFrame();
    }
    const positions = pool.points.geometry.getAttribute('position').array;
    for (let index = 0; index < pool.particleCount(); index++) {
      expect(Math.abs(positions[index * 3])).toBeLessThan(10);
    }
    pool.dispose();
  });
});
