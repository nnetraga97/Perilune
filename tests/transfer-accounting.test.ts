import { describe, expect, it } from 'vitest';
import { derivePlanetTransfer } from '../src/proto/feasibilityTransfer';

describe('planet transfer accounting', () => {
  it('derives selected body pack, boot-critical, and transient bytes from a manifest', () => {
    const manifest = {
      packs: [
        { bodyId: 'veyra', tier: 'medium', compressedBytes: 10, transientBytes: 100, bootCritical: true },
        { bodyId: 'luma', tier: 'medium', compressedBytes: 20, transientBytes: 200, bootCritical: true },
        { bodyId: 'veyra', tier: 'low', compressedBytes: 4, transientBytes: 40, bootCritical: false },
      ],
    };
    expect(derivePlanetTransfer(manifest, 'veyra', 'medium')).toEqual({
      bodyPackCompressedBytes: 10,
      bootCriticalBytes: 30,
      transientBytes: 100,
      manifestPackCount: 3,
      selectedPackCount: 1,
    });
  });

  it('truthfully reports zero for a manifest without packs', () => {
    expect(derivePlanetTransfer({ packs: [] }, 'veyra', 'medium')).toEqual({
      bodyPackCompressedBytes: 0,
      bootCriticalBytes: 0,
      transientBytes: 0,
      manifestPackCount: 0,
      selectedPackCount: 0,
    });
  });
});
