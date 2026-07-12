import * as THREE from 'three';
import planetManifest from '../../assets/planets/manifest.json';
import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import { AUREN_SYSTEM } from '../content/system';
import { createRenderContext } from '../render/context';
import { GpuTimerRing, type GpuTimerSnapshot } from '../render/gpuTimer';
import { makeStarfield } from '../render/starfield';
import {
  categorizeResources,
  drawingBufferResourceBytes,
  geometryByteLength,
} from '../render/resourceAccounting';
import { bodyFixedToInertial, bodyOrientation } from '../sim/bodyOrientation';
import { terrainHeight } from '../sim/terrain';
import { Universe } from '../sim/universe';
import { PerfOverlay } from '../ui/perfOverlay';
import {
  reductionStage,
  summarizeJourney,
  summarizeReferenceRun,
  type FeasibilityFeatureConfig,
  type FeasibilitySample,
  type FeasibilityTier,
  type JourneySummary,
  type ReferenceRunSummary,
} from './feasibilityMetrics';
import {
  FeasibilityScene,
  type FeasibilitySceneStats,
  type ProfilingGroup,
} from './feasibilityScene';
import { applicationResourceTransfer, derivePlanetTransfer } from './feasibilityTransfer';

export type CameraRegime = 'orbit' | 'atmosphere' | 'low-flight' | 'surface';
type FeasibilityMode = 'smoke' | 'reference';

export interface FeasibilityPublicState {
  readonly runNonce: string;
  readonly mode: FeasibilityMode;
  readonly tier: FeasibilityTier;
  /** Retained for artifact compatibility; identical to requestedReductionStage. */
  readonly reductionStage: number;
  readonly requestedReductionStage: number;
  readonly effectiveReductionStage: number;
  readonly protocol: {
    readonly warmupSeconds: number;
    readonly journeySeconds: number;
    readonly journeyCount: 3;
    readonly drainSeconds: number;
  };
  readonly phase: 'warmup' | 'journey' | 'drain' | 'complete';
  readonly journeyIndex: number;
  readonly caps: {
    readonly backend: 'webgl2';
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    readonly drawingBufferSamples: number;
    readonly gpuTimerSupported: boolean;
    readonly renderer: string;
    readonly vendor: string;
  };
  readonly features: Readonly<FeasibilityFeatureConfig>;
  readonly scene: Readonly<FeasibilitySceneStats>;
  readonly resources: {
    readonly categories: Readonly<Record<string, number>>;
    readonly activeBodyBytes: number;
    readonly totalRendererBytes: number;
    readonly transientBytes: number;
    readonly uncompressedWorstCaseBytes: number;
  };
  readonly transfer: {
    readonly bodyPackCompressedBytes: number;
    readonly bootCriticalBytes: number;
    readonly transientBytes: number;
    readonly manifestPackCount: number;
    readonly selectedPackCount: number;
    readonly applicationTransferBytes: number;
    readonly applicationEncodedBytes: number;
  };
  readonly visitedRegimes: readonly CameraRegime[];
  readonly journeys: readonly JourneySummary[];
  readonly summary: ReferenceRunSummary | null;
  readonly gpuTimer: Readonly<GpuTimerSnapshot>;
  readonly elapsedSeconds: number;
  readonly telemetry: {
    readonly drawCalls: number;
    readonly triangles: number;
    readonly maxDrawCalls: number;
    readonly maxTriangles: number;
    readonly transitionOverlapMs: number;
    readonly transitionMode: 'forced-combined-fixture';
    readonly rendererGeometryCount: number;
    readonly rendererTextureCount: number;
    readonly accountedGeometryCount: number;
    readonly accountedTextureCount: number;
  };
}

declare global {
  interface Window {
    __FEASIBILITY__?: FeasibilityPublicState;
    __FEASIBILITY_DONE__?: boolean;
    __SET_FEASIBILITY_FEATURE__?: (feature: string, enabled: boolean) => void;
    __SET_FEASIBILITY_GROUP__?: (group: string, enabled: boolean) => void;
  }
}

interface MutableSample {
  frameMs: number;
  submissionMs: number;
  terrainMs: number;
  gpuMs: number | null;
}

const DRAWING_BUFFER_WIDTH = 1920;
const DRAWING_BUFFER_HEIGHT = 1080;

function parseMode(value: string | null): FeasibilityMode {
  return value === 'reference' ? 'reference' : 'smoke';
}

function parseTier(value: string | null): FeasibilityTier {
  return value === 'low' ? 'low' : 'medium';
}

function parseStage(value: string | null): number {
  const stage = Number(value ?? 0);
  return Number.isInteger(stage) && stage >= 0 && stage <= 5 ? stage : 0;
}

function regimeAt(progress: number): { regime: CameraRegime; local: number } {
  const scaled = Math.min(0.999999, Math.max(0, progress)) * 4;
  const index = Math.floor(scaled);
  const regimes: readonly CameraRegime[] = ['orbit', 'atmosphere', 'low-flight', 'surface'];
  return { regime: regimes[index], local: scaled - index };
}

/**
 * Upper bound on how far the measurement protocol may advance per rendered
 * frame. Software renderers (CI runs on SwiftShader) stall for whole seconds
 * on first-use shader compilation, so an unclamped wall clock lets a single
 * frame leap across an entire journey window and leave it with one sample.
 * Clamping guarantees a journey of J seconds spans at least
 * J * 1000 / MAX_PROTOCOL_STEP_MS rendered frames; frames faster than the
 * clamp advance the protocol in real time, so capable hardware is unaffected.
 */
export const MAX_PROTOCOL_STEP_MS = 100;

/** Protocol-clock advance for one rendered frame, in milliseconds. */
export function protocolStepMs(frameMs: number): number {
  if (!Number.isFinite(frameMs)) return MAX_PROTOCOL_STEP_MS;
  return Math.min(Math.max(0, frameMs), MAX_PROTOCOL_STEP_MS);
}

/** Regimes traversed by a protocol-clock interval, including those skipped by a long rendered frame. */
export function cameraRegimesCrossed(
  previousElapsed: number,
  currentElapsed: number,
  journeySeconds: number,
): readonly CameraRegime[] {
  if (!(journeySeconds > 0) || !Number.isFinite(journeySeconds)) {
    throw new Error('Journey duration must be finite and positive');
  }
  const start = Math.max(0, Math.min(previousElapsed, currentElapsed));
  const end = Math.max(start, currentElapsed);
  const firstJourney = Math.floor(start / journeySeconds);
  const lastJourney = end === 0 ? 0 : Math.max(firstJourney, Math.ceil(end / journeySeconds) - 1);
  const regimes: readonly CameraRegime[] = ['orbit', 'atmosphere', 'low-flight', 'surface'];
  const crossed: CameraRegime[] = [];
  for (let journey = firstJourney; journey <= lastJourney; journey++) {
    const journeyStart = journey * journeySeconds;
    const localStart = Math.max(0, (start - journeyStart) / journeySeconds);
    const localEnd = Math.min(1, (end - journeyStart) / journeySeconds);
    if (localStart > 1 || localEnd < 0) continue;
    const firstRegime = Math.floor(Math.min(0.999999, localStart) * regimes.length);
    const lastRegime = Math.floor(Math.min(0.999999, localEnd) * regimes.length);
    for (let index = firstRegime; index <= lastRegime; index++) crossed.push(regimes[index]);
  }
  return crossed;
}

function altitudeFor(regime: CameraRegime, local: number, atmosphereHeight: number): number {
  const lerp = (start: number, end: number) => start + (end - start) * local;
  if (regime === 'orbit') return lerp(500_000, atmosphereHeight * 1.15);
  if (regime === 'atmosphere') return lerp(atmosphereHeight * 0.95, 8_000);
  if (regime === 'low-flight') return lerp(8_000, 300);
  return lerp(80, 12);
}

function longitudeFor(regime: CameraRegime, local: number): number {
  if (regime === 'orbit') return -0.3 + local * 0.25;
  if (regime === 'atmosphere') return -0.05 + local * 0.04;
  if (regime === 'low-flight') return -0.01 + local * 0.0092;
  return -0.0008 + local * 0.0016;
}

export async function runFeasibilityProto(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mode = parseMode(params.get('mode'));
  const tier = parseTier(params.get('tier'));
  const stage = parseStage(params.get('stage'));
  const runNonce = params.get('nonce') ?? '';
  const warmupSeconds = mode === 'reference' ? 30 : 1.5;
  const journeySeconds = mode === 'reference' ? 300 : 3;
  const drainSeconds = mode === 'reference' ? 2 : 0.75;

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  const context = await createRenderContext(canvas);
  if (context.caps.backend !== 'webgl2') {
    throw new Error('The planet feasibility prototype requires WebGL2');
  }
  const { renderer } = context;
  renderer.setPixelRatio(1);
  renderer.setSize(DRAWING_BUFFER_WIDTH, DRAWING_BUFFER_HEIGHT, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const universe = new Universe(AUREN_SYSTEM);
  const veyra = universe.get('veyra');
  let features = reductionStage(stage, tier);
  const fixture = new FeasibilityScene(veyra, features);
  const disabledGroups = (params.get('disabled') ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);
  const profilingGroupNames: readonly ProfilingGroup[] = [
    'terrain', 'atmosphere', 'ocean', 'clouds', 'scatter', 'transition',
  ];
  for (const group of disabledGroups) {
    if (!profilingGroupNames.includes(group as ProfilingGroup)) {
      throw new Error(`Unknown disabled profiling group ${group}`);
    }
    fixture.setProfilingGroup(group as ProfilingGroup, false);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#03070c');
  const starfield = makeStarfield(4200);
  scene.add(starfield, fixture.group);
  const sun = new THREE.DirectionalLight('#fff1d2', 2.5);
  sun.position.set(1_200, 1_800, 900);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -1_600;
  sun.shadow.camera.right = 1_600;
  sun.shadow.camera.top = 1_600;
  sun.shadow.camera.bottom = -1_600;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 5_000;
  scene.add(sun, sun.target, new THREE.AmbientLight('#1b2b3d', 0.35));

  const camera = new THREE.PerspectiveCamera(
    60,
    DRAWING_BUFFER_WIDTH / DRAWING_BUFFER_HEIGHT,
    0.5,
    1e9,
  );
  camera.position.set(0, 0, 0);

  const gl = renderer.getContext() as WebGL2RenderingContext;
  const gpuTimer = new GpuTimerRing(gl, 12);
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_RENDERER_WEBGL: number;
    UNMASKED_VENDOR_WEBGL: number;
  } | null;
  const gpuName = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'masked';
  const gpuVendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : 'masked';
  const drawingBufferSamples = Number(gl.getParameter(gl.SAMPLES));
  const manifestTransfer = derivePlanetTransfer(planetManifest, veyra.id, tier);

  const perf = new PerfOverlay(uiRoot);
  perf.toggle();
  document.getElementById('boot')?.remove();

  const journeySamples: MutableSample[][] = [[], [], []];
  const sampleByGpuLabel = new Map<string, { sample: MutableSample; journeyIndex: number }>();
  const journeyDisjointSamples = [0, 0, 0];
  const journeyInvalidSamples = [0, 0, 0];
  const visitedRegimes = new Set<CameraRegime>();
  let journeySummaries: JourneySummary[] = [];
  let summary: ReferenceRunSummary | null = null;
  let phase: FeasibilityPublicState['phase'] = 'warmup';
  let journeyIndex = -1;
  let frameNumber = 0;
  let complete = false;
  let lastPublish = 0;
  let drawCalls = 0;
  let triangles = 0;
  let maxDrawCalls = 0;
  let maxTriangles = 0;
  let transitionOverlapMs = 0;
  let previousJourneyElapsed = 0;
  // The protocol clock: wall time advanced by at most MAX_PROTOCOL_STEP_MS per
  // frame, so phases always contain enough rendered frames to summarize.
  let protocolElapsedSeconds = 0;

  const camBodyFixed = new Vec3();
  const camInertial = new Vec3();
  const originWorld = new Vec3();
  const direction = new Vec3();
  const aheadDirection = new Vec3();
  const aheadInertial = new Vec3();
  const orientation = new Quat();
  const cameraUp = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  const publish = (elapsedSeconds: number) => {
    const buffer = new THREE.Vector2();
    renderer.getDrawingBufferSize(buffer);
    const drawingBuffer = drawingBufferResourceBytes(buffer.x, buffer.y, drawingBufferSamples);
    const bodyResources = fixture.resourceStats(2048 * 2048 * 4);
    const resources = categorizeResources({
      activeBody: bodyResources.categories,
      rendererOnly: {
        starfieldGeometryBytes: geometryByteLength(starfield.geometry),
        drawingBufferColorBytes: drawingBuffer.colorBytes,
        drawingBufferDepthBytes: drawingBuffer.depthBytes,
      },
      transientBytes: manifestTransfer.transientBytes,
    });
    const measuredTransfer = applicationResourceTransfer([
      ...performance.getEntriesByType('navigation'),
      ...performance.getEntriesByType('resource'),
    ]);
    window.__FEASIBILITY__ = {
      runNonce,
      mode,
      tier,
      reductionStage: stage,
      requestedReductionStage: stage,
      effectiveReductionStage: features.effectiveStage,
      protocol: {
        warmupSeconds,
        journeySeconds,
        journeyCount: 3,
        drainSeconds,
      },
      phase,
      journeyIndex,
      caps: {
        backend: 'webgl2',
        drawingBufferWidth: buffer.x,
        drawingBufferHeight: buffer.y,
        drawingBufferSamples,
        gpuTimerSupported: gpuTimer.snapshot().supported,
        renderer: gpuName,
        vendor: gpuVendor,
      },
      features,
      scene: fixture.stats(),
      resources,
      transfer: {
        ...manifestTransfer,
        applicationTransferBytes: measuredTransfer.transferBytes,
        applicationEncodedBytes: measuredTransfer.encodedBytes,
      },
      visitedRegimes: [...visitedRegimes],
      journeys: journeySummaries,
      summary,
      gpuTimer: gpuTimer.snapshot(),
      elapsedSeconds,
      telemetry: {
        drawCalls,
        triangles,
        maxDrawCalls,
        maxTriangles,
        transitionOverlapMs,
        transitionMode: 'forced-combined-fixture',
        rendererGeometryCount: renderer.info.memory.geometries,
        rendererTextureCount: renderer.info.memory.textures,
        accountedGeometryCount: bodyResources.geometryCount + 1,
        accountedTextureCount: bodyResources.textureCount,
      },
    };
  };

  window.__SET_FEASIBILITY_FEATURE__ = (feature, enabled) => {
    if (!['cloudShadows', 'secondCloudScale', 'oceanGlitter'].includes(feature)) {
      throw new Error(`Unsupported feasibility feature toggle ${feature}`);
    }
    features = Object.freeze({ ...features, [feature]: enabled });
    fixture.setFeatures(features);
    publish(protocolElapsedSeconds);
  };
  window.__SET_FEASIBILITY_GROUP__ = (group, enabled) => {
    if (!profilingGroupNames.includes(group as ProfilingGroup)) {
      throw new Error(`Unsupported feasibility profiling group ${group}`);
    }
    fixture.setProfilingGroup(group as ProfilingGroup, enabled);
    publish(protocolElapsedSeconds);
  };

  const startedAt = performance.now();
  let lastFrameAt = startedAt;
  const frame = () => {
    const now = performance.now();
    const frameMs = now - lastFrameAt;
    lastFrameAt = now;
    protocolElapsedSeconds += protocolStepMs(frameMs) / 1000;
    const elapsedSeconds = protocolElapsedSeconds;

    const journeyElapsed = elapsedSeconds - warmupSeconds;
    if (journeyElapsed < 0) {
      phase = 'warmup';
      journeyIndex = -1;
    } else if (journeyElapsed < journeySeconds * 3) {
      phase = 'journey';
      journeyIndex = Math.floor(journeyElapsed / journeySeconds);
    } else if (journeyElapsed < journeySeconds * 3 + drainSeconds) {
      phase = 'drain';
      journeyIndex = 2;
    } else {
      phase = 'complete';
      journeyIndex = 2;
    }

    const activeJourneyProgress = phase === 'journey'
      ? (journeyElapsed - journeyIndex * journeySeconds) / journeySeconds
      : phase === 'warmup'
        ? 0
        : 0.999999;
    // Smoke runs are intentionally short and SwiftShader may skip a quarter-regime
    // between frames. Reference certification still records rendered regimes only.
    if (mode === 'smoke' && journeyElapsed >= 0) {
      const boundedJourneyElapsed = Math.min(journeySeconds * 3, journeyElapsed);
      for (const crossed of cameraRegimesCrossed(previousJourneyElapsed, boundedJourneyElapsed, journeySeconds)) {
        visitedRegimes.add(crossed);
      }
      previousJourneyElapsed = boundedJourneyElapsed;
    }
    const { regime, local } = regimeAt(activeJourneyProgress);
    if (mode === 'reference' && phase === 'journey') visitedRegimes.add(regime);
    const atmosphereHeight = veyra.def.atmosphere?.height ?? 70_000;
    const altitude = altitudeFor(regime, local, atmosphereHeight);
    const longitude = longitudeFor(regime, local);
    const latitude = regime === 'orbit' ? 0.08 * (1 - local) : 0;
    direction.set(
      Math.sin(longitude) * Math.cos(latitude),
      -Math.cos(longitude) * Math.cos(latitude),
      Math.sin(latitude),
    ).normalize();
    const groundRadius = veyra.radius + terrainHeight(veyra, direction);
    camBodyFixed.copy(direction).scale(groundRadius + altitude);
    bodyFixedToInertial(veyra, elapsedSeconds, camBodyFixed, camInertial);
    originWorld.copy(camInertial).negate();
    bodyOrientation(veyra, elapsedSeconds, orientation);

    const simStart = performance.now();
    fixture.update(camBodyFixed, orientation, originWorld, elapsedSeconds, altitude);
    const fixtureStats = fixture.stats();
    perf.endSim(simStart);

    bodyFixedToInertial(veyra, elapsedSeconds, direction, aheadInertial);
    cameraUp.set(aheadInertial.x, aheadInertial.y, aheadInertial.z);
    if (regime === 'orbit') {
      lookTarget.set(originWorld.x, originWorld.y, originWorld.z);
    } else {
      const aheadLongitude = longitude + (regime === 'surface' ? 0.0006 : 0.006);
      aheadDirection.set(Math.sin(aheadLongitude), -Math.cos(aheadLongitude), 0).normalize();
      bodyFixedToInertial(veyra, elapsedSeconds, aheadDirection, aheadInertial).scale(groundRadius + altitude * 0.35);
      lookTarget.set(
        aheadInertial.x - camInertial.x,
        aheadInertial.y - camInertial.y,
        aheadInertial.z - camInertial.z,
      );
    }
    camera.up.copy(cameraUp);
    camera.lookAt(lookTarget);

    const gpuLabel = `journey-${journeyIndex}-frame-${frameNumber++}`;
    const sample = phase === 'journey'
      ? {
          frameMs,
          submissionMs: 0,
          terrainMs: fixtureStats.terrainScheduleMs + fixtureStats.terrainInstallMs,
          gpuMs: null,
        }
      : null;
    const gpuIssued = phase === 'journey' && gpuTimer.begin(gpuLabel);
    const submissionStart = performance.now();
    renderer.render(scene, camera);
    const submissionMs = performance.now() - submissionStart;
    if (sample) sample.submissionMs = submissionMs;
    drawCalls = renderer.info.render.calls;
    triangles = renderer.info.render.triangles;
    maxDrawCalls = Math.max(maxDrawCalls, drawCalls);
    maxTriangles = Math.max(maxTriangles, triangles);
    if (phase === 'journey' && fixtureStats.profilingGroups.transition) {
      transitionOverlapMs += protocolStepMs(frameMs);
    }
    if (phase === 'journey') gpuTimer.end();
    perf.endRender(submissionStart);
    perf.setExtra('scatter', fixtureStats.visualScatterCount);
    perf.setExtra('proxies', fixtureStats.physicalProxyCount);
    perf.setExtra('gpu MB', ((window.__FEASIBILITY__?.resources.activeBodyBytes ?? 0) / 1048576).toFixed(1));
    perf.setExtra('disjoint', gpuTimer.snapshot().disjointSamples);
    perf.setExtra('transition ms', transitionOverlapMs.toFixed(1));
    perf.setExtra('download bytes', window.__FEASIBILITY__?.transfer.bodyPackCompressedBytes ?? 0);
    perf.setExtra('regime', regime);
    perf.frame(frameMs, renderer);

    if (sample) {
      journeySamples[journeyIndex].push(sample);
      if (gpuIssued) sampleByGpuLabel.set(gpuLabel, { sample, journeyIndex });
    }
    for (const timing of gpuTimer.poll()) {
      const issued = sampleByGpuLabel.get(timing.label);
      if (issued && timing.status === 'valid') issued.sample.gpuMs = timing.milliseconds;
      if (issued && timing.status === 'disjoint') {
        journeyDisjointSamples[issued.journeyIndex]++;
      }
      if (issued && timing.status === 'invalid') {
        journeyInvalidSamples[issued.journeyIndex]++;
      }
      sampleByGpuLabel.delete(timing.label);
    }

    if (phase === 'complete' && !complete) {
      complete = true;
      for (const timing of gpuTimer.abandonPending()) {
        const issued = sampleByGpuLabel.get(timing.label);
        if (issued && timing.status === 'disjoint') {
          journeyDisjointSamples[issued.journeyIndex]++;
        }
        sampleByGpuLabel.delete(timing.label);
      }
      sampleByGpuLabel.clear();
      journeySummaries = journeySamples.map((samples, index) => summarizeJourney(
        samples as FeasibilitySample[],
        {
          disjointGpuSamples: journeyDisjointSamples[index],
          invalidGpuSamples: journeyInvalidSamples[index],
        },
      ));
      summary = summarizeReferenceRun(journeySummaries);
      publish(elapsedSeconds);
      window.__FEASIBILITY_DONE__ = true;
      console.info('[feasibility] complete', JSON.stringify(window.__FEASIBILITY__));
      return;
    }

    if (now - lastPublish >= 200) {
      lastPublish = now;
      publish(elapsedSeconds);
    }
    requestAnimationFrame(frame);
  };

  publish(0);
  requestAnimationFrame(frame);
  window.addEventListener('pagehide', () => {
    gpuTimer.dispose();
    fixture.dispose();
    renderer.dispose();
  }, { once: true });
}
