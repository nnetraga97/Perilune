import { describe, expect, it, vi } from 'vitest';
import {
  artemisIvHighTierRendererBaseBytes,
  preflightArtemisIvAssets,
} from '../src/missions/artemisIv/assets';
import {
  applyArtemisIvRenderScale,
  artemisIvMissionPixelRatio,
} from '../src/missions/artemisIv/renderScale';
import { drawingBufferResourceBytes } from '../src/render/resourceAccounting';

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const MSAA_SAMPLES = 4;

function decisionAt(pixelRatio: number) {
  const drawingBufferBytes = drawingBufferResourceBytes(
    Math.floor(VIEWPORT_WIDTH * pixelRatio),
    Math.floor(VIEWPORT_HEIGHT * pixelRatio),
    MSAA_SAMPLES,
  ).totalBytes;
  const base = artemisIvHighTierRendererBaseBytes({ residentPackGpuBytes: 0, drawingBufferBytes });
  return preflightArtemisIvAssets({
    currentTier: 'medium',
    supportsHighTier: true,
    caps: { backend: 'webgl2', maxTextureSize: 8192 },
    ledger: { totalRendererBytes: () => base },
  });
}

describe('Artemis IV mission-only render scaling', () => {
  it('keeps mission DPR at 1 while the expanded combined budget also admits a common DPR 2 editor preview', () => {
    expect(decisionAt(2)).toMatchObject({ ok: true });

    let pixelRatio = 2;
    const setPixelRatio = vi.fn((next: number) => { pixelRatio = next; });
    const lease = applyArtemisIvRenderScale({
      getPixelRatio: () => pixelRatio,
      setPixelRatio,
    });

    expect(lease).toMatchObject({ previousPixelRatio: 2, missionPixelRatio: 1, scaled: true });
    expect(decisionAt(pixelRatio)).toMatchObject({
      ok: true,
      requiredTier: 'high',
      switchToTier: 'high',
    });

    lease.restore();
    lease.restore();
    expect(pixelRatio).toBe(2);
    expect(setPixelRatio.mock.calls).toEqual([[1], [2]]);
  });

  it('does not upscale a renderer already at or below native CSS resolution', () => {
    expect(artemisIvMissionPixelRatio(0.75)).toBe(0.75);
    const setPixelRatio = vi.fn();
    const lease = applyArtemisIvRenderScale({ getPixelRatio: () => 1, setPixelRatio });
    expect(lease.scaled).toBe(false);
    lease.restore();
    expect(setPixelRatio).not.toHaveBeenCalled();
  });

  it('rejects invalid source ratios instead of silently choosing an unsafe scale', () => {
    expect(() => artemisIvMissionPixelRatio(0)).toThrow(/pixel ratio/i);
    expect(() => artemisIvMissionPixelRatio(Number.NaN)).toThrow(/pixel ratio/i);
  });
});
