/**
 * Artemis IV keeps the checked High visual tier and the unchanged Starship
 * textures, but limits output resolution on HiDPI displays while those large
 * resources are resident. Three.js retains this ratio across window resizes.
 */
export const ARTEMIS_IV_MISSION_MAX_PIXEL_RATIO = 1;

export interface ArtemisIvPixelRatioRenderer {
  getPixelRatio(): number;
  setPixelRatio(pixelRatio: number): void;
}

export interface ArtemisIvRenderScaleLease {
  readonly previousPixelRatio: number;
  readonly missionPixelRatio: number;
  readonly scaled: boolean;
  /** Restore the exact pre-mission ratio. Safe to call more than once. */
  restore(): void;
}

export function artemisIvMissionPixelRatio(currentPixelRatio: number): number {
  if (!Number.isFinite(currentPixelRatio) || currentPixelRatio <= 0) {
    throw new Error(`Invalid renderer pixel ratio ${currentPixelRatio}`);
  }
  return Math.min(currentPixelRatio, ARTEMIS_IV_MISSION_MAX_PIXEL_RATIO);
}

/** Acquire mission-only output scaling without changing the renderer quality tier. */
export function applyArtemisIvRenderScale(
  renderer: ArtemisIvPixelRatioRenderer,
): ArtemisIvRenderScaleLease {
  const previousPixelRatio = renderer.getPixelRatio();
  const missionPixelRatio = artemisIvMissionPixelRatio(previousPixelRatio);
  const scaled = missionPixelRatio !== previousPixelRatio;
  if (scaled) renderer.setPixelRatio(missionPixelRatio);

  let restored = false;
  return Object.freeze({
    previousPixelRatio,
    missionPixelRatio,
    scaled,
    restore(): void {
      if (restored) return;
      restored = true;
      if (scaled) renderer.setPixelRatio(previousPixelRatio);
    },
  });
}
