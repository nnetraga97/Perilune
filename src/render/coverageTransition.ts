export type CoverageTransitionState = 'compact' | 'prewarming' | 'fading' | 'terrain';

export interface CoverageTransitionSnapshot {
  readonly state: CoverageTransitionState;
  readonly compactCoverage: number;
  readonly terrainCoverage: number;
  readonly progress: number;
}

export interface CoverageTransitionOptions {
  readonly normalDurationSeconds?: number;
  readonly pressureDurationSeconds?: number;
  readonly hardMaximumSeconds?: number;
}

/** Wall-clock transition whose fade cannot begin until terrain has complete coverage. */
export class CoverageTransition {
  readonly normalDurationSeconds: number;
  readonly pressureDurationSeconds: number;
  readonly hardMaximumSeconds: number;
  private requested = false;
  private state: CoverageTransitionState = 'compact';
  private fadeElapsed = 0;
  private fadeDuration: number;

  constructor(options: Readonly<CoverageTransitionOptions> = {}) {
    this.normalDurationSeconds = options.normalDurationSeconds ?? 0.35;
    this.pressureDurationSeconds = options.pressureDurationSeconds ?? 0.2;
    this.hardMaximumSeconds = options.hardMaximumSeconds ?? 1.5;
    this.fadeDuration = this.normalDurationSeconds;
    if (this.normalDurationSeconds <= 0 || this.pressureDurationSeconds <= 0 || this.hardMaximumSeconds <= 0) {
      throw new Error('Coverage transition durations must be positive');
    }
  }

  requestTerrain(): CoverageTransitionSnapshot {
    this.requested = true;
    if (this.state === 'compact') this.state = 'prewarming';
    return this.snapshot();
  }

  requestCompact(): CoverageTransitionSnapshot {
    this.requested = false;
    this.state = 'compact';
    this.fadeElapsed = 0;
    this.fadeDuration = this.normalDurationSeconds;
    return this.snapshot();
  }

  update(deltaSeconds: number, coverageReady: boolean, framePressure: boolean): CoverageTransitionSnapshot {
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    if (!this.requested) return this.requestCompact();
    if (!coverageReady) {
      this.state = 'prewarming';
      this.fadeElapsed = 0;
      this.fadeDuration = this.normalDurationSeconds;
      return this.snapshot();
    }
    if (this.state === 'prewarming' || this.state === 'compact') {
      // This observation establishes t=0. Load/prewarm time never leaks into fade time.
      this.state = 'fading';
      this.fadeElapsed = 0;
      this.fadeDuration = framePressure ? this.pressureDurationSeconds : this.normalDurationSeconds;
      return this.snapshot();
    }
    if (this.state === 'terrain') return this.snapshot();

    this.fadeElapsed += delta;
    if (framePressure) this.fadeDuration = Math.min(this.fadeDuration, this.pressureDurationSeconds);
    if (this.fadeElapsed >= this.fadeDuration || this.fadeElapsed >= this.hardMaximumSeconds) {
      this.state = 'terrain';
    }
    return this.snapshot();
  }

  snapshot(): CoverageTransitionSnapshot {
    const progress = this.state === 'terrain' ? 1 : this.state === 'fading'
      ? Math.max(0, Math.min(1, this.fadeElapsed / this.fadeDuration))
      : 0;
    return Object.freeze({
      state: this.state,
      compactCoverage: 1 - progress,
      terrainCoverage: progress,
      progress,
    });
  }
}
