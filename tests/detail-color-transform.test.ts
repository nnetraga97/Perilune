import { describe, expect, it } from 'vitest';
import { detailColorTransform } from '../src/render/planetDetail/detailColorTransform';

describe('planet detail visual color transform', () => {
  it('leaves source-compatible Earth imagery unchanged', () => {
    expect(detailColorTransform('nasa-gibs-bmng-500m-v1', new Uint8ClampedArray([20, 30, 40, 255])))
      .toEqual({ scale: [1, 1, 1], bias: [0, 0, 0] });
  });

  it('matches dark Moon Trek WAC pages to the checked lunar parent exposure', () => {
    const pixels = new Uint8ClampedArray(64 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([80, 80, 80, 255], offset);
    const transform = detailColorTransform('nasa-moontrek-wac-303ppd-v02', pixels);
    const linear80 = ((80 / 255 + 0.055) / 1.055) ** 2.4;
    expect(transform.scale).toEqual([1.35, 1.35, 1.35]);
    expect(linear80 * transform.scale[0] + transform.bias[0]).toBeCloseTo(0.515, 6);
    expect(linear80 * transform.scale[1] + transform.bias[1]).toBeCloseTo(0.497, 6);
    expect(linear80 * transform.scale[2] + transform.bias[2]).toBeCloseTo(0.474, 6);
  });
});
