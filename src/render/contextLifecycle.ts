export type RenderLifecycleState = 'ready' | 'lost' | 'restoring' | 'fallback';

export interface RenderContextLifecycleOptions {
  readonly log?: (message: string) => void;
}

interface RestorationSubscription {
  readonly restore: () => Promise<void>;
  active: boolean;
  queuedGeneration: number;
}

/** Owns WebGL context events and serializes scene restoration ownership. */
export class RenderContextLifecycle {
  private currentState: RenderLifecycleState = 'ready';
  private readonly subscriptions = new Map<number, RestorationSubscription>();
  private nextSubscriptionId = 1;
  private generation = 0;
  private restoreTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly log: (message: string) => void;

  constructor(
    private readonly canvas: EventTarget,
    options: RenderContextLifecycleOptions = {},
  ) {
    this.log = options.log ?? ((message) => console.warn(message));
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  get state(): RenderLifecycleState { return this.currentState; }
  get renderPaused(): boolean {
    return this.currentState === 'lost' || this.currentState === 'restoring';
  }

  subscribeRestoration(restore: () => Promise<void>): () => void {
    if (this.disposed) return () => undefined;
    const id = this.nextSubscriptionId++;
    const subscription: RestorationSubscription = { restore, active: true, queuedGeneration: -1 };
    this.subscriptions.set(id, subscription);
    return () => {
      subscription.active = false;
      this.subscriptions.delete(id);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (const subscription of this.subscriptions.values()) subscription.active = false;
    this.subscriptions.clear();
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed || this.currentState === 'lost') return;
    this.generation++;
    this.currentState = 'lost';
    this.log('WebGL context lost; rendering paused while simulation continues.');
  };

  private readonly onContextRestored = (): void => {
    if (this.disposed || this.currentState !== 'lost') return;
    const generation = ++this.generation;
    this.currentState = 'restoring';
    this.restoreTail = this.restoreTail
      .then(() => this.runRestorationWave(generation))
      .catch(() => undefined);
  };

  private async runRestorationWave(generation: number): Promise<void> {
    let failed = false;
    while (!this.disposed && this.generation === generation && this.currentState === 'restoring') {
      const next = [...this.subscriptions.values()].find(
        (subscription) => subscription.active && subscription.queuedGeneration !== generation,
      );
      if (!next) break;
      next.queuedGeneration = generation;
      try {
        await next.restore();
      } catch {
        if (next.active) failed = true;
      }
    }
    if (!this.disposed && this.generation === generation && this.currentState === 'restoring') {
      this.currentState = failed ? 'fallback' : 'ready';
    }
  }
}

export function shouldRenderFrame(context: Pick<RenderContextLifecycle, 'state'>): boolean {
  return context.state !== 'lost' && context.state !== 'restoring';
}
