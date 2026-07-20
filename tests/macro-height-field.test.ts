import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { solidHeight } from '../src/sim/terrain';
import {
  CHECKED_HEIGHT_AUTHORITY_VERSION,
  sampleSourceMacroHeight,
  sourceHeightGrid,
} from '../src/sim/sourceHeightAuthority';
import { Universe } from '../src/sim/universe';

function direction(latitudeDegrees: number, longitudeDegrees: number): Vec3 {
  const latitude = latitudeDegrees * Math.PI / 180;
  const longitude = longitudeDegrees * Math.PI / 180;
  return new Vec3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
}

describe('checked source macro height authority', () => {
  it('pins an immutable, checksummed coarse level for Earth and Moon', () => {
    expect(CHECKED_HEIGHT_AUTHORITY_VERSION).toMatch(/^[a-f0-9]{64}$/);
    for (const bodyId of ['earth', 'moon']) {
      const grid = sourceHeightGrid(bodyId)!;
      expect(grid).toMatchObject({ bodyId, width: 512, height: 256 });
      expect(grid.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(grid.samples.length).toBe(512 * 256);
    }
  });

  it('wraps the antimeridian without a seam and preserves measured Earth relief', () => {
    const west = sampleSourceMacroHeight('earth', direction(10, -179.999))!;
    const east = sampleSourceMacroHeight('earth', direction(10, 180.001))!;
    expect(west).toBeCloseTo(east, 6);
    expect(sampleSourceMacroHeight('earth', direction(0, -140))).toBeLessThan(-3_000);
    expect(sampleSourceMacroHeight('earth', direction(28, 87))).toBeGreaterThan(3_000);
  });

  it('feeds the same source macro plus canonical detail to synchronous contact', () => {
    const universe = new Universe([...SOL_SYSTEM], 'earth');
    for (const bodyId of ['earth', 'moon']) {
      const body = universe.get(bodyId);
      const sampleDirection = direction(bodyId === 'earth' ? 35 : 18, bodyId === 'earth' ? -105 : -57);
      const macro = sampleSourceMacroHeight(bodyId, sampleDirection)!;
      const surface = solidHeight(body, sampleDirection);
      expect(surface.kind).toBe('solid');
      if (surface.kind === 'solid') expect(Math.abs(surface.height - macro)).toBeLessThan(160);
    }
  });
});
