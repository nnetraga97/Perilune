interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface TimerSlot {
  readonly query: WebGLQuery;
  pending: boolean;
  label: string;
  sequence: number;
}

export interface GpuTimingSample {
  readonly label: string;
  readonly milliseconds: number;
}

export interface GpuTimerSnapshot {
  readonly supported: boolean;
  readonly pending: number;
  readonly validSamples: number;
  readonly disjointSamples: number;
  readonly unavailablePolls: number;
  readonly saturatedBegins: number;
}

/**
 * Non-blocking elapsed-time query ring. Results are consumed only after the
 * driver marks them available; a full ring drops profiling work, never a
 * render frame.
 */
export class GpuTimerRing {
  private readonly extension: DisjointTimerQueryExtension | null;
  private readonly slots: TimerSlot[] = [];
  private active: TimerSlot | null = null;
  private skippedEnd = false;
  private nextSequence = 0;
  private validSamples = 0;
  private disjointSamples = 0;
  private unavailablePolls = 0;
  private saturatedBegins = 0;
  private disposed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    ringSize = 8,
  ) {
    if (!Number.isInteger(ringSize) || ringSize < 1) {
      throw new Error(`GPU timer ring size must be a positive integer; received ${ringSize}`);
    }
    this.extension = gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as DisjointTimerQueryExtension | null;
    if (!this.extension) return;
    for (let index = 0; index < ringSize; index++) {
      const query = gl.createQuery();
      if (!query) throw new Error(`Could not allocate GPU timer query ${index + 1}/${ringSize}`);
      this.slots.push({ query, pending: false, label: '', sequence: -1 });
    }
  }

  begin(label: string): boolean {
    if (this.disposed) throw new Error('GPU timer ring is disposed');
    if (this.active || this.skippedEnd) throw new Error('GPU timer query is already active');
    if (!this.extension) {
      this.skippedEnd = true;
      return false;
    }
    const slot = this.slots.find((candidate) => !candidate.pending);
    if (!slot) {
      this.saturatedBegins++;
      this.skippedEnd = true;
      return false;
    }
    slot.label = label;
    slot.sequence = this.nextSequence++;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, slot.query);
    this.active = slot;
    return true;
  }

  end(): void {
    if (this.disposed) throw new Error('GPU timer ring is disposed');
    if (this.skippedEnd) {
      this.skippedEnd = false;
      return;
    }
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.active.pending = true;
    this.active = null;
  }

  poll(): GpuTimingSample[] {
    if (this.disposed) throw new Error('GPU timer ring is disposed');
    if (!this.extension) return [];
    const completed: GpuTimingSample[] = [];
    const pending = this.slots
      .filter((slot) => slot.pending)
      .sort((a, b) => a.sequence - b.sequence);
    for (const slot of pending) {
      const available = Boolean(
        this.gl.getQueryParameter(slot.query, this.gl.QUERY_RESULT_AVAILABLE),
      );
      if (!available) {
        this.unavailablePolls++;
        continue;
      }
      const disjoint = Boolean(this.gl.getParameter(this.extension.GPU_DISJOINT_EXT));
      if (disjoint) {
        this.disjointSamples++;
      } else {
        const nanoseconds = Number(this.gl.getQueryParameter(slot.query, this.gl.QUERY_RESULT));
        if (Number.isFinite(nanoseconds) && nanoseconds >= 0) {
          completed.push({ label: slot.label, milliseconds: nanoseconds / 1_000_000 });
          this.validSamples++;
        } else {
          this.disjointSamples++;
        }
      }
      slot.pending = false;
      slot.label = '';
    }
    return completed;
  }

  snapshot(): Readonly<GpuTimerSnapshot> {
    return Object.freeze({
      supported: this.extension !== null,
      pending: this.slots.filter((slot) => slot.pending).length,
      validSamples: this.validSamples,
      disjointSamples: this.disjointSamples,
      unavailablePolls: this.unavailablePolls,
      saturatedBegins: this.saturatedBegins,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.active && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.active = null;
    }
    for (const slot of this.slots) this.gl.deleteQuery(slot.query);
    this.disposed = true;
  }
}
