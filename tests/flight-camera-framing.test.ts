import { describe, expect, it } from 'vitest';
import { ARTEMIS_IV_CAMERA_FRAMING_RADII } from '../src/missions/artemisIv/visuals';
import { flightCameraDistanceForVisualRadius } from '../src/render/worldScene';
import { createFirstLightRocket } from '../src/content/crafts';
import { computeMassProperties, craftAxialVisualBounds, craftVisualRadius } from '../src/sim/vessel';

describe('external flight visual camera framing', () => {
  it('fits the full Artemis HLS envelope while preserving the stock default path', () => {
    const stockDistance = 18;
    const hlsDistance = flightCameraDistanceForVisualRadius(
      ARTEMIS_IV_CAMERA_FRAMING_RADII.hls,
      62,
      16 / 9,
    );

    expect(hlsDistance).toBeGreaterThan(100);
    expect(stockDistance).toBe(18);
  });

  it('uses the narrower screen axis and rejects invalid envelopes', () => {
    const landscape = flightCameraDistanceForVisualRadius(10, 62, 16 / 9);
    const portrait = flightCameraDistanceForVisualRadius(10, 62, 9 / 16);
    expect(portrait).toBeGreaterThan(landscape);
    expect(() => flightCameraDistanceForVisualRadius(0, 62, 1)).toThrow(/radius/);
  });

  it('frames the tall First Light stack around its offset center of mass', () => {
    const craft = createFirstLightRocket();
    const com = computeMassProperties(craft).com;
    const bounds = craftAxialVisualBounds(craft);
    const radius = craftVisualRadius(craft, { x: com.x, y: bounds.center, z: com.z });
    const distance = flightCameraDistanceForVisualRadius(radius, 62, 16 / 9);

    expect(bounds.center - com.y).toBeGreaterThan(5);
    expect(bounds.center - com.y).toBeLessThan(bounds.maximum - com.y);
    expect(bounds.center - com.y - (bounds.maximum - bounds.minimum) * 0.08)
      .toBeGreaterThan(bounds.minimum - com.y);
    expect(radius).toBeGreaterThan(20);
    expect(distance).toBeGreaterThan(40);
  });
});
