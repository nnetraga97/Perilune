import { describe, expect, it } from 'vitest';
import {
  ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
  ARTEMIS_IV_PREFLIGHT_ACTIONS,
  artemisIvHighTierRendererBaseBytes,
  recheckArtemisIvPreparedSceneBudget,
  type ArtemisIvAssetResourceAccounting,
} from '../src/missions/artemisIv/assets';
import { DEFAULT_ACTIVE_BODY_BUDGET } from '../src/render/resourceAccounting';
import { createArtemisIvRendererResourceLedger } from '../src/missions/artemisIv/runtime';

function accounting(gpuBytes: number): ArtemisIvAssetResourceAccounting {
  return {
    assetId: 'martiandays-starship-2019-concept',
    transferBytes: 1,
    geometryBytes: 0,
    materialBytes: 0,
    textureBytes: gpuBytes,
    gpuBytes,
    geometryCount: 0,
    materialCount: 0,
    textureCount: 1,
    drawCallCount: 1,
    triangleCount: 0,
  };
}

describe('Artemis IV combined renderer budget', () => {
  it('reserves the required High active-body tier in the live renderer base', () => {
    const residentPackGpuBytes = 12_345;
    const drawingBufferBytes = 67_890;

    const base = artemisIvHighTierRendererBaseBytes({ residentPackGpuBytes, drawingBufferBytes });

    expect(base).toBe(DEFAULT_ACTIVE_BODY_BUDGET.high + drawingBufferBytes);
    expect(base).not.toBe(DEFAULT_ACTIVE_BODY_BUDGET.low + drawingBufferBytes);
    expect(artemisIvHighTierRendererBaseBytes({
      residentPackGpuBytes: DEFAULT_ACTIVE_BODY_BUDGET.high + 1,
      drawingBufferBytes,
    })).toBe(DEFAULT_ACTIVE_BODY_BUDGET.high + 1 + drawingBufferBytes);
  });

  it('rechecks the live combined total after body preparation and returns recovery actions', () => {
    const starshipBytes = 350_000_000;
    let preparedRendererBase = 100_000_000;
    const ledger = createArtemisIvRendererResourceLedger(() => preparedRendererBase);
    ledger.charge(accounting(starshipBytes));

    expect(recheckArtemisIvPreparedSceneBudget(ledger)).toEqual({
      ok: true,
      currentRendererBytes: preparedRendererBase + starshipBytes,
      combinedSceneGpuCapBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
      headroomBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES - preparedRendererBase - starshipBytes,
    });

    preparedRendererBase = ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES - starshipBytes + 1;
    const rejected = recheckArtemisIvPreparedSceneBudget(ledger);
    expect(rejected).toEqual({
      ok: false,
      code: 'combined-scene-budget',
      reason: 'The prepared Artemis IV craft, terrain, and renderer exceed the certified High-quality scene budget.',
      currentRendererBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES + 1,
      combinedSceneGpuCapBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
      overBudgetBytes: 1,
      actions: ARTEMIS_IV_PREFLIGHT_ACTIONS,
    });
  });
});
