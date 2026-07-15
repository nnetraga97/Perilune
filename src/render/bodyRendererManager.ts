import type * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { BodyRenderer, QualityTier, RuntimeBodyAssetPack } from './bodyRenderer';
import { renderFailureKey, RenderFailureTracker, type RenderFailurePhase, type RenderFailureStats } from './renderFailures';
import { normalizeDiagnosticError, type RenderDiagnosticsPort } from './renderDiagnostics';

export interface LoadedRendererAssets {
  /** Owns the lifetime of the borrowed textures exposed through pack. */
  readonly pack: Readonly<RuntimeBodyAssetPack> | null;
  readonly gpuBytes: number;
  readonly transientBytes: number;
  readonly flightScale: boolean;
  dispose(): void;
}

interface TierBudgets {
  readonly activeBodyGpuBytes: Readonly<Record<QualityTier, number>>;
  readonly transientPeakBytes: Readonly<Record<QualityTier, number>>;
}

interface ResidentPack {
  readonly owner: symbol;
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly assets: LoadedRendererAssets;
}

export interface RendererResourceSnapshot {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly gpuBytes: number;
  readonly transientBytes: number;
}

export interface BodyRendererManagerStats {
  readonly committed: boolean;
  readonly transactionActive: boolean;
  readonly quality: QualityTier;
  readonly failures: number;
  readonly transitionMs: number;
}

export class RendererResourceLedger {
  private resident: ResidentPack | null = null;
  private readonly budgets: TierBudgets;

  constructor(budgets: TierBudgets) {
    this.budgets = Object.freeze({
      activeBodyGpuBytes: Object.freeze({ ...budgets.activeBodyGpuBytes }),
      transientPeakBytes: Object.freeze({ ...budgets.transientPeakBytes }),
    });
  }

  activeBodyBudget(tier: QualityTier): number {
    return this.budgets.activeBodyGpuBytes[tier];
  }

  assertCanStage(tier: QualityTier, assets: Readonly<LoadedRendererAssets>): void {
    if (assets.transientBytes > this.budgets.transientPeakBytes[tier]) {
      throw new Error(`Candidate transient allocation exceeds ${tier} budget`);
    }
    if (assets.gpuBytes > this.budgets.activeBodyGpuBytes[tier]) {
      throw new Error(`Candidate GPU allocation exceeds ${tier} active-body budget`);
    }
  }

  commit(owner: symbol, bodyId: string, tier: QualityTier, assets: LoadedRendererAssets): LoadedRendererAssets | null {
    const previous = this.resident?.assets ?? null;
    if (!assets.flightScale) return null;
    if (this.resident && this.resident.owner !== owner) {
      throw new Error(`Flight-scale residency is owned by ${this.resident.bodyId}`);
    }
    this.resident = { owner, bodyId, tier, assets };
    return previous === assets ? null : previous;
  }

  release(owner: symbol, assets: LoadedRendererAssets): void {
    if (this.resident?.owner === owner && this.resident.assets === assets) this.resident = null;
  }

  residentFlightBodyIds(): string[] {
    return this.resident ? [this.resident.bodyId] : [];
  }

  snapshot(): Readonly<RendererResourceSnapshot> | null {
    if (!this.resident) return null;
    return Object.freeze({
      bodyId: this.resident.bodyId,
      tier: this.resident.tier,
      gpuBytes: this.resident.assets.gpuBytes,
      transientBytes: this.resident.assets.transientBytes,
    });
  }
}

interface TransactionBoundaries {
  readonly loadAssets: (body: Body, tier: QualityTier) => Promise<LoadedRendererAssets>;
  readonly prepareCandidate: (candidate: BodyRenderer, body: Body, tier: QualityTier) => Promise<void>;
  readonly compileCandidate: (candidate: BodyRenderer, body: Body, tier: QualityTier) => Promise<void>;
  readonly awaitCoverage: (candidate: BodyRenderer, body: Body, tier: QualityTier) => Promise<void>;
}

export interface BodyRendererManagerOptions extends TransactionBoundaries {
  readonly scene: THREE.Scene;
  readonly quality: QualityTier;
  readonly createCandidate: (body: Body, tier: QualityTier) => BodyRenderer;
  readonly ledger: RendererResourceLedger;
  readonly failures?: RenderFailureTracker;
  readonly now?: () => number;
  readonly diagnostics?: RenderDiagnosticsPort;
}

interface CommittedRenderer {
  readonly body: Body;
  readonly renderer: BodyRenderer;
  readonly assets: LoadedRendererAssets;
}

export class BodyRendererManager {
  private static nextIdentity = 1;
  private quality: QualityTier;
  private committed: CommittedRenderer | null = null;
  private candidate: BodyRenderer | null = null;
  private boundaries: TransactionBoundaries;
  private readonly failures: RenderFailureTracker;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private readonly ledgerOwner = Symbol('BodyRendererManager');
  private readonly now: () => number;
  private transactionStartedAt: number | null = null;
  private lastTransitionMs = 0;
  private readonly identity = BodyRendererManager.nextIdentity++;

  constructor(private readonly options: BodyRendererManagerOptions) {
    this.quality = options.quality;
    this.boundaries = options;
    this.failures = options.failures ?? new RenderFailureTracker();
    this.now = options.now ?? (() => performance.now());
  }

  setBoundaries(boundaries: Partial<TransactionBoundaries>): void {
    this.boundaries = { ...this.boundaries, ...boundaries };
  }

  current(): BodyRenderer | null { return this.committed?.renderer ?? null; }
  currentAssetPack(): Readonly<RuntimeBodyAssetPack> | null { return this.committed?.assets.pack ?? null; }
  failureStats(): Readonly<RenderFailureStats> { return this.failures.stats(); }
  platformStats(): Readonly<BodyRendererManagerStats> {
    return Object.freeze({
      committed: this.committed !== null,
      transactionActive: this.candidate !== null,
      quality: this.quality,
      failures: this.failures.stats().total,
      transitionMs: this.transactionStartedAt === null
        ? this.lastTransitionMs
        : Math.max(0, this.now() - this.transactionStartedAt),
    });
  }

  adoptInitial(body: Body, renderer: BodyRenderer, assets: LoadedRendererAssets): void {
    if (this.disposed) throw new Error('Body renderer manager is disposed');
    if (this.committed || this.candidate) throw new Error('Body renderer manager already has visual state');
    this.options.ledger.assertCanStage(renderer.quality, assets);
    const replaced = this.options.ledger.commit(this.ledgerOwner, body.id, renderer.quality, assets);
    renderer.root.visible = true;
    this.options.scene.add(renderer.root);
    this.committed = { body, renderer, assets };
    this.record('renderer-initial-adopted', 'state', body, renderer.quality, renderer, {
      activeRendererRoots: 1,
      generation: this.generation,
    });
    this.options.diagnostics?.noteRendererBoundary({
      managerIdentity: this.identity,
      rendererIdentity: renderer.root.uuid,
      quality: renderer.quality,
      reason: 'initial-adoption',
    }, { bodyId: body.id });
    replaced?.dispose();
  }

  ensure(body: Body): Promise<BodyRenderer> {
    if (this.committed?.body.id === body.id && this.committed.renderer.quality === this.quality) {
      return Promise.resolve(this.committed.renderer);
    }
    return this.enqueue(() => this.transact(body, this.quality));
  }

  replaceQuality(tier: QualityTier): Promise<void> {
    if (this.committed?.renderer.quality === tier) {
      this.quality = tier;
      return Promise.resolve();
    }
    if (!this.committed) {
      this.quality = tier;
      return Promise.resolve();
    }
    const body = this.committed.body;
    return this.enqueue(async () => {
      await this.transact(body, tier);
      this.quality = tier;
    });
  }

  rebuildCommitted(): Promise<void> {
    if (!this.committed) return Promise.resolve();
    const body = this.committed.body;
    return this.enqueue(async () => { await this.transact(body, this.quality); });
  }

  /** Release only the active-body budget claim while keeping visual state live. */
  releaseFlightResidency(): void {
    if (this.committed) this.options.ledger.release(this.ledgerOwner, this.committed.assets);
  }

  /** Reclaim an already-loaded flight-scale pack without rebuilding the renderer. */
  claimFlightResidency(): boolean {
    if (!this.committed?.assets.flightScale) return false;
    this.options.ledger.assertCanStage(this.committed.renderer.quality, this.committed.assets);
    this.options.ledger.commit(
      this.ledgerOwner,
      this.committed.body.id,
      this.committed.renderer.quality,
      this.committed.assets,
    );
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.finishTransition();
    if (this.candidate) {
      this.record('candidate-disposed', 'state', this.committed?.body ?? null, this.candidate.quality, this.candidate, { reason: 'manager-dispose' });
      this.candidate.dispose();
    }
    this.candidate = null;
    if (!this.committed) return;
    this.options.scene.remove(this.committed.renderer.root);
    this.record('renderer-disposed', 'state', this.committed.body, this.committed.renderer.quality, this.committed.renderer, { reason: 'manager-dispose' });
    this.committed.renderer.dispose();
    this.options.ledger.release(this.ledgerOwner, this.committed.assets);
    this.committed.assets.dispose();
    this.committed = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async transact(body: Body, tier: QualityTier): Promise<BodyRenderer> {
    if (this.disposed) throw new Error('Body renderer manager is disposed');
    const generation = this.generation;
    const assertCurrent = () => {
      if (this.disposed || generation !== this.generation) throw new Error('Renderer transaction is stale after disposal');
    };
    const renderer = this.options.createCandidate(body, tier);
    renderer.root.visible = false;
    this.candidate = renderer;
    this.transactionStartedAt = this.now();
    this.record('candidate-created', 'state', body, tier, renderer, { generation });
    let loaded: LoadedRendererAssets | null = null;
    let phase: RenderFailurePhase = 'load';
    try {
      this.record('asset-load-start', 'state', body, tier, renderer, { generation });
      loaded = await this.boundaries.loadAssets(body, tier);
      assertCurrent();
      renderer.stageAssets(loaded.pack);
      this.record('assets-staged', 'state', body, tier, renderer, {
        generation,
        assetPack: loaded.pack !== null,
        gpuBytes: loaded.gpuBytes,
        transientBytes: loaded.transientBytes,
      });
      assertCurrent();
      phase = 'coverage';
      await this.boundaries.prepareCandidate(renderer, body, tier);
      this.record('candidate-prepared', 'state', body, tier, renderer, { generation });
      assertCurrent();
      phase = 'compile';
      this.record('compile-start', 'state', body, tier, renderer, { generation });
      await this.boundaries.compileCandidate(renderer, body, tier);
      this.record('compile-success', 'state', body, tier, renderer, { generation });
      assertCurrent();
      phase = 'coverage';
      await this.boundaries.awaitCoverage(renderer, body, tier);
      this.record('coverage-ready', 'state', body, tier, renderer, { generation });
      assertCurrent();
      phase = 'budget';
      this.options.ledger.assertCanStage(tier, loaded);
      this.record('budget-accepted', 'state', body, tier, renderer, {
        generation,
        gpuBytes: loaded.gpuBytes,
        transientBytes: loaded.transientBytes,
      });

      const previous = this.committed;
      const replacedAssets = this.options.ledger.commit(this.ledgerOwner, body.id, tier, loaded);
      if (previous) {
        renderer.root.position.copy(previous.renderer.root.position);
        renderer.root.quaternion.copy(previous.renderer.root.quaternion);
        renderer.root.scale.copy(previous.renderer.root.scale);
      }
      this.options.scene.add(renderer.root);
      renderer.root.visible = true;
      this.committed = { body, renderer, assets: loaded };
      this.candidate = null;
      this.record('renderer-committed', 'state', body, tier, renderer, {
        generation,
        previousRendererIdentity: previous?.renderer.root.uuid ?? null,
        activeRendererRoots: previous ? 2 : 1,
        transactionDurationMs: this.transactionStartedAt === null ? 0 : Math.max(0, this.now() - this.transactionStartedAt),
      });
      this.options.diagnostics?.noteRendererBoundary({
        managerIdentity: this.identity,
        rendererIdentity: renderer.root.uuid,
        quality: tier,
        reason: 'transaction-commit',
      }, { bodyId: body.id });
      if (previous) {
        this.options.scene.remove(previous.renderer.root);
        previous.renderer.dispose();
        if (!loaded.flightScale) this.options.ledger.release(this.ledgerOwner, previous.assets);
        if (previous.assets !== replacedAssets) previous.assets.dispose();
        this.record('previous-disposed', 'state', body, tier, renderer, {
          generation,
          previousRendererIdentity: previous.renderer.root.uuid,
          activeRendererRoots: 1,
        });
      }
      if (replacedAssets) replacedAssets.dispose();
      return renderer;
    } catch (error) {
      const normalized = normalizeDiagnosticError(error);
      const failureKey = renderFailureKey(error);
      this.record('renderer-transaction-failed', 'failure', body, tier, renderer, {
        generation,
        phase: failureKey?.phase ?? phase,
        channel: failureKey?.channel ?? 'renderer',
        errorName: normalized.name,
        errorMessage: normalized.message,
      });
      this.failures.record(renderFailureKey(error) ?? { body: body.id, tier, channel: 'renderer', phase }, error);
      if (this.candidate === renderer) renderer.dispose();
      loaded?.dispose();
      if (this.candidate === renderer) this.candidate = null;
      throw error;
    } finally {
      this.finishTransition();
    }
  }

  private finishTransition(): void {
    if (this.transactionStartedAt === null) return;
    this.lastTransitionMs = Math.max(0, this.now() - this.transactionStartedAt);
    this.transactionStartedAt = null;
  }

  private record(
    event: string,
    severity: 'state' | 'failure',
    body: Body | null,
    tier: QualityTier,
    renderer: BodyRenderer,
    data: Readonly<Record<string, string | number | boolean | null>> = {},
  ): void {
    this.options.diagnostics?.record({
      subsystem: 'renderer',
      event,
      severity,
      data: {
        managerIdentity: this.identity,
        body: body?.id ?? renderer.bodyId,
        tier,
        candidateIdentity: renderer.root.uuid,
        committedIdentity: this.committed?.renderer.root.uuid ?? null,
        ...data,
      },
    }, { bodyId: body?.id ?? renderer.bodyId });
  }
}
