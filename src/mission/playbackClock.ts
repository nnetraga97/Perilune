import {
  MISSION_PLAYBACK_RATES,
  type MissionClockChange,
  type MissionClockSnapshot,
  type MissionPhaseDefinition,
  type MissionPlaybackRate,
  type MissionTimeChangeKind,
} from './types';

export interface MissionClockBounds {
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;
}

export interface MissionClockOptions {
  readonly initialTimeSeconds?: number;
  readonly initialRate?: MissionPlaybackRate;
  readonly initiallyPlaying?: boolean;
}

function isPlaybackRate(value: number): value is MissionPlaybackRate {
  return MISSION_PLAYBACK_RATES.some((rate) => rate === value);
}

/** Wall-clock driver for an otherwise direct-time, deterministic replay. */
export class MissionPlaybackClock {
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;

  private currentTimeSeconds: number;
  private playing: boolean;
  private selectedRate: MissionPlaybackRate;
  private discontinuityCounter = 0;
  private change: MissionClockChange;

  constructor(bounds: MissionClockBounds, options: MissionClockOptions = {}) {
    if (!Number.isFinite(bounds.startTimeSeconds) || !Number.isFinite(bounds.endTimeSeconds)) {
      throw new RangeError('Mission clock bounds must be finite');
    }
    if (bounds.endTimeSeconds <= bounds.startTimeSeconds) {
      throw new RangeError('Mission clock end must be after its start');
    }
    const initialRate = options.initialRate ?? 1;
    if (!isPlaybackRate(initialRate)) {
      throw new RangeError(`Unsupported mission playback rate: ${initialRate}`);
    }
    const requestedInitialTime = options.initialTimeSeconds ?? bounds.startTimeSeconds;
    if (!Number.isFinite(requestedInitialTime)) throw new RangeError('Initial mission time must be finite');

    this.startTimeSeconds = bounds.startTimeSeconds;
    this.endTimeSeconds = bounds.endTimeSeconds;
    this.currentTimeSeconds = this.clampTime(requestedInitialTime);
    this.selectedRate = initialRate;
    this.playing = Boolean(options.initiallyPlaying) && this.currentTimeSeconds < this.endTimeSeconds;
    this.change = {
      kind: 'initial',
      previousTimeSeconds: this.currentTimeSeconds,
      timeSeconds: this.currentTimeSeconds,
      discontinuity: true,
      discontinuityToken: this.discontinuityCounter,
    };
  }

  get timeSeconds(): number {
    return this.currentTimeSeconds;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get rate(): MissionPlaybackRate {
    return this.selectedRate;
  }

  get lastChange(): MissionClockChange {
    return this.change;
  }

  play(): MissionClockSnapshot {
    this.playing = this.currentTimeSeconds < this.endTimeSeconds;
    return this.snapshot();
  }

  pause(): MissionClockSnapshot {
    this.playing = false;
    return this.snapshot();
  }

  togglePlayback(): MissionClockSnapshot {
    return this.playing ? this.pause() : this.play();
  }

  setRate(rate: MissionPlaybackRate): MissionClockSnapshot {
    if (!isPlaybackRate(rate)) throw new RangeError(`Unsupported mission playback rate: ${rate}`);
    this.selectedRate = rate;
    return this.snapshot();
  }

  advance(wallDeltaSeconds: number): MissionClockSnapshot {
    if (!Number.isFinite(wallDeltaSeconds) || wallDeltaSeconds < 0) {
      throw new RangeError('Mission clock wall delta must be finite and non-negative');
    }
    const previous = this.currentTimeSeconds;
    if (this.playing && wallDeltaSeconds > 0) {
      this.currentTimeSeconds = this.clampTime(previous + wallDeltaSeconds * this.selectedRate);
      if (this.currentTimeSeconds >= this.endTimeSeconds) this.playing = false;
    }
    this.change = this.makeContinuousChange(previous);
    return this.snapshot();
  }

  seek(timeSeconds: number): MissionClockSnapshot {
    return this.setDiscontinuousTime(timeSeconds, 'seek');
  }

  jumpToPhase(
    phase: Pick<MissionPhaseDefinition, 'startTimeSeconds' | 'suggestedRate'>,
    options: { readonly applySuggestedRate?: boolean } = {},
  ): MissionClockSnapshot {
    if (options.applySuggestedRate) this.setRate(phase.suggestedRate);
    return this.setDiscontinuousTime(phase.startTimeSeconds, 'phase-jump');
  }

  restartPhase(phase: Pick<MissionPhaseDefinition, 'startTimeSeconds'>): MissionClockSnapshot {
    return this.setDiscontinuousTime(phase.startTimeSeconds, 'phase-restart');
  }

  snapshot(): MissionClockSnapshot {
    return {
      timeSeconds: this.currentTimeSeconds,
      isPlaying: this.playing,
      rate: this.selectedRate,
      startTimeSeconds: this.startTimeSeconds,
      endTimeSeconds: this.endTimeSeconds,
      lastChange: this.change,
    };
  }

  private clampTime(timeSeconds: number): number {
    return Math.max(this.startTimeSeconds, Math.min(this.endTimeSeconds, timeSeconds));
  }

  private makeContinuousChange(previousTimeSeconds: number): MissionClockChange {
    return {
      kind: 'advance',
      previousTimeSeconds,
      timeSeconds: this.currentTimeSeconds,
      discontinuity: false,
      discontinuityToken: this.discontinuityCounter,
    };
  }

  private setDiscontinuousTime(timeSeconds: number, kind: Exclude<MissionTimeChangeKind, 'initial' | 'advance'>): MissionClockSnapshot {
    if (!Number.isFinite(timeSeconds)) throw new RangeError('Mission seek time must be finite');
    const previous = this.currentTimeSeconds;
    this.currentTimeSeconds = this.clampTime(timeSeconds);
    if (this.currentTimeSeconds >= this.endTimeSeconds) this.playing = false;
    this.discontinuityCounter += 1;
    this.change = {
      kind,
      previousTimeSeconds: previous,
      timeSeconds: this.currentTimeSeconds,
      discontinuity: true,
      discontinuityToken: this.discontinuityCounter,
    };
    return this.snapshot();
  }
}
