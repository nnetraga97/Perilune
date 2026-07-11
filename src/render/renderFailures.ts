import type { QualityTier } from './bodyRenderer';

export type RenderFailurePhase = 'load' | 'compile' | 'coverage' | 'budget';

export interface RenderFailureKey {
  readonly body: string;
  readonly tier: QualityTier;
  readonly channel: string;
  readonly phase: RenderFailurePhase;
}

export interface RenderFailureStats {
  readonly total: number;
  readonly load: number;
  readonly compile: number;
  readonly coverage: number;
  readonly budget: number;
}

export class RenderFailureTracker {
  private readonly seen = new Set<string>();
  private readonly counters: Record<RenderFailurePhase, number> = {
    load: 0, compile: 0, coverage: 0, budget: 0,
  };
  private total = 0;

  constructor(private readonly log: (message: string, error: unknown) => void = console.error) {}

  record(key: Readonly<RenderFailureKey>, error: unknown): void {
    this.total++;
    this.counters[key.phase]++;
    const identity = `${key.body}\u0000${key.tier}\u0000${key.channel}\u0000${key.phase}`;
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    this.log(`[renderer:${key.body}/${key.tier}/${key.channel}/${key.phase}]`, error);
  }

  stats(): Readonly<RenderFailureStats> {
    return Object.freeze({ total: this.total, ...this.counters });
  }
}
