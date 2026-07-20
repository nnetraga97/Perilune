import * as THREE from 'three';
import { SOL_CONSTANTS_SOURCE_SHA256 } from '../generated/checked-sol-constants';
import checkedPlanetArtifact from '../generated/checked-planet-manifest.json';
import { SOL_SYSTEM } from '../content/system';
import { Body, Universe } from '../sim/universe';
import { bodyMaterialDescriptor } from '../render/bodyMaterial';
import type { BodyRenderFrame, QualityTier, RuntimeBodyAssetPack } from '../render/bodyRenderer';
import { createBodyRendererCandidate } from '../render/bodyRendererFactory';
import { computeCelestialProjection } from '../render/celestialProjection';
import { celestialOcclusion } from '../render/celestialOcclusion';
import { createRenderContext } from '../render/context';
import { environmentLighting, localShadowPolicy } from '../render/lightingPolicy';
import { checkPlanetManifest } from '../render/planetAssetLoader';
import { BODY_VISUALS } from '../content/bodyVisuals';
import { solVisualReferenceStation } from './solVisualReferenceStations';
import { solidHeight } from '../sim/terrain';
import { Vec3 } from '../core/vec3';

interface ReferenceApi {
  ready: boolean;
  metadata: Record<string, unknown>;
}

function direction(latitudeDegrees: number, longitudeDegrees: number): THREE.Vector3 {
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  return new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
}

async function loadFallbackPack(bodyId: 'earth' | 'moon', tier: QualityTier): Promise<RuntimeBodyAssetPack> {
  const manifest = checkPlanetManifest(checkedPlanetArtifact);
  const pack = manifest.packs.find((candidate) => candidate.bodyId === bodyId && candidate.tier === tier);
  if (!pack) throw new Error(`Missing checked visual-reference pack ${bodyId}/${tier}`);
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  const loader = new THREE.TextureLoader();
  const textures = new Map<string, THREE.Texture>();
  await Promise.all(pack.channels.map(async (channel) => {
    const texture = await loader.loadAsync(`${base}planets/${channel.fallbackPath}`);
    texture.flipY = false;
    textures.set(channel.name, texture);
  }));
  return Object.freeze({
    bodyId, tier, width: pack.width, height: pack.height,
    manifestDigest: manifest.digest,
    gpuBytes: pack.channels.reduce((sum, channel) => sum + channel.fallbackGpuBytes, 0),
    textures,
  });
}

function fallbackReferenceBudget(pack: Readonly<RuntimeBodyAssetPack>): number {
  const manifest = checkPlanetManifest(checkedPlanetArtifact);
  // The reference harness intentionally decodes conventional PNG/WebP files,
  // whose RGBA allocation is much larger than the production KTX2 pack. Give
  // that harness-only fallback enough room for the proven terrain pool without
  // changing the production active-body ledger.
  return Math.max(manifest.budgets.activeBodyGpuBytes[pack.tier], pack.gpuBytes + 32 * 1024 * 1024);
}

export async function runSolVisualReferenceProto(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const requestedTier = params.get('quality');
  const quality: QualityTier = requestedTier === 'low' || requestedTier === 'high' ? requestedTier : 'medium';
  const station = solVisualReferenceStation(params.get('station') ?? 'earth-day-full');
  const diagnosticLayer = params.get('diagnostic');
  const requestedTime = Number(params.get('time'));
  const referenceTimeSeconds = params.has('time') && Number.isFinite(requestedTime)
    ? requestedTime
    : station.timeSeconds;
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const context = await createRenderContext(canvas);
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  context.renderer.shadowMap.enabled = quality !== 'low';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(station.fovDegrees, innerWidth / innerHeight, 0.3, 6e8);
  camera.position.set(0, 0, 0);
  const universe = new Universe([...SOL_SYSTEM], 'earth');
  const body: Body = universe.get(station.bodyId);
  const cameraDirectionBodyFixed = direction(station.latitudeDegrees, station.longitudeDegrees);
  const sampledSurface = station.presentation === 'surface'
    ? solidHeight(body, new Vec3(
      cameraDirectionBodyFixed.x,
      cameraDirectionBodyFixed.y,
      cameraDirectionBodyFixed.z,
    ))
    : { kind: 'none' as const };
  const surfaceHeight = sampledSurface.kind === 'solid' ? sampledSurface.height : 0;
  const observerSurfaceHeight = body.def.terrain.oceanLevel > 0 && surfaceHeight < 0
    ? 0
    : surfaceHeight;
  const observerAltitude = station.altitudeMeters + observerSurfaceHeight;
  const observerDistance = body.radius + observerAltitude;
  const bodyOrigin = cameraDirectionBodyFixed.clone().multiplyScalar(-observerDistance);
  const viewDirectionBodyFixed = cameraDirectionBodyFixed.clone().multiplyScalar(-1);
  if (station.presentation === 'surface') {
    const east = new THREE.Vector3(-cameraDirectionBodyFixed.y, cameraDirectionBodyFixed.x, 0);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const pitch = THREE.MathUtils.degToRad(station.pitchDegrees ?? 10);
    viewDirectionBodyFixed.copy(east).multiplyScalar(Math.cos(pitch))
      .addScaledVector(cameraDirectionBodyFixed, -Math.sin(pitch)).normalize();
    camera.up.copy(cameraDirectionBodyFixed);
    camera.lookAt(viewDirectionBodyFixed);
  } else {
    camera.up.set(0, 0, 1);
    camera.lookAt(bodyOrigin);
  }
  camera.updateMatrixWorld(true);

  const primaryPack = station.bodyId === 'earth' || station.bodyId === 'moon'
    ? await loadFallbackPack(station.bodyId, quality)
    : null;
  const renderer = createBodyRendererCandidate({
    body,
    caps: context.caps,
    quality,
    activeBodyBudgetBytes: primaryPack ? fallbackReferenceBudget(primaryPack) : undefined,
  });
  if (station.bodyId === 'earth' || station.bodyId === 'moon') {
    renderer.stageAssets(primaryPack);
  }
  scene.add(renderer.root);
  let secondaryRenderer: ReturnType<typeof createBodyRendererCandidate> | null = null;
  let secondaryFrame: BodyRenderFrame | null = null;
  if (station.id === 'earth-moon-true-scale') {
    const moon = universe.get('moon');
    const meanSeparation = moon.def.orbit?.a ?? 384_400_000;
    const moonOrigin = bodyOrigin.clone().add(new THREE.Vector3(0, meanSeparation, 0));
    const moonObserverDistance = moonOrigin.length();
    const moonPack = await loadFallbackPack('moon', quality);
    secondaryRenderer = createBodyRendererCandidate({ body: moon, caps: context.caps, quality });
    secondaryRenderer.stageAssets(moonPack);
    scene.add(secondaryRenderer.root);
    secondaryFrame = {
      cameraRelativeOrigin: moonOrigin,
      cameraBodyFixed: moonOrigin.clone().multiplyScalar(-1),
      cameraViewDirectionBodyFixed: moonOrigin.clone().normalize(),
      cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
      verticalFovRadians: THREE.MathUtils.degToRad(station.fovDegrees),
      drawingBufferHeight: Math.max(1, context.renderer.getDrawingBufferSize(new THREE.Vector2()).y),
      projection: computeCelestialProjection({
        centerRelative: moonOrigin,
        bodyRadius: moon.radius,
        verticalFovRadians: THREE.MathUtils.degToRad(station.fovDegrees),
        drawingBufferHeight: Math.max(1, context.renderer.getDrawingBufferSize(new THREE.Vector2()).y),
        physicalFarMeters: camera.far,
        farField: moonObserverDistance - moon.radius > camera.far,
      }),
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      cameraSunDirection: new THREE.Vector3(...station.sunDirection).normalize(),
      bodySunDirection: new THREE.Vector3(...station.sunDirection).normalize(),
      solarVisibleFraction: 1,
      time: referenceTimeSeconds,
      deltaSeconds: 1 / 60,
      framePressure: false,
      altitude: moonObserverDistance - moon.radius,
      allowFlightTerrain: false,
    };
  }
  const sunDirection = new THREE.Vector3(...station.sunDirection).normalize();
  const projection = computeCelestialProjection({
    centerRelative: bodyOrigin,
    bodyRadius: body.radius,
    verticalFovRadians: THREE.MathUtils.degToRad(station.fovDegrees),
    drawingBufferHeight: Math.max(1, context.renderer.getDrawingBufferSize(new THREE.Vector2()).y),
    physicalFarMeters: camera.far,
    farField: station.bodyId === 'sun' || observerDistance - body.radius > camera.far,
  });
  let solarVisibleFraction = 1;
  let solarOccluder: BodyRenderFrame['solarOccluder'];
  if (station.id === 'sun-partial-occultation') {
    const moon = universe.get('moon');
    const lunarAngularRadius = Math.asin(moon.radius / 384_400_000);
    const offset = projection.angularRadius * 0.7;
    const center = bodyOrigin.clone().normalize();
    const right = new THREE.Vector3().crossVectors(center, camera.up).normalize();
    const occultingDirection = center.clone().multiplyScalar(Math.cos(offset))
      .addScaledVector(right, Math.sin(offset));
    solarOccluder = { direction: occultingDirection, angularRadius: lunarAngularRadius };
    solarVisibleFraction = celestialOcclusion(
      { direction: center, angularRadius: projection.angularRadius },
      solarOccluder,
    ).sourceVisibleFraction;
  }
  const frame: BodyRenderFrame = {
    cameraRelativeOrigin: bodyOrigin,
    cameraBodyFixed: cameraDirectionBodyFixed.clone().multiplyScalar(observerDistance),
    cameraViewDirectionBodyFixed: viewDirectionBodyFixed,
    surfaceAnchorBodyFixed: cameraDirectionBodyFixed.clone().multiplyScalar(body.radius + surfaceHeight),
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: THREE.MathUtils.degToRad(station.fovDegrees),
    drawingBufferHeight: Math.max(1, context.renderer.getDrawingBufferSize(new THREE.Vector2()).y),
    projection,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: station.bodyId === 'sun' ? bodyOrigin.clone().normalize() : sunDirection,
    bodySunDirection: sunDirection,
    solarVisibleFraction,
    solarOccluder,
    time: referenceTimeSeconds,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: observerAltitude,
    allowFlightTerrain: station.presentation === 'surface' || station.presentation === 'orbit',
  };
  const environment = environmentLighting(
    BODY_VISUALS[station.bodyId].renderer,
    body.def.atmosphere?.height ?? 0,
    observerAltitude,
    Math.max(0, cameraDirectionBodyFixed.dot(sunDirection)),
    1,
    station.bodyId === 'sun',
  );
  scene.background = new THREE.Color(environment.background);
  scene.add(new THREE.HemisphereLight(environment.sky, environment.ground, environment.intensity));
  if (station.bodyId !== 'sun') {
    const direct = new THREE.DirectionalLight('#fff4df', 3.1);
    const shadow = localShadowPolicy(quality, observerDistance, observerAltitude);
    direct.position.copy(sunDirection).multiplyScalar(shadow.lightDistance);
    direct.castShadow = shadow.enabled && diagnosticLayer !== 'no-shadows';
    direct.shadow.mapSize.set(shadow.mapSize, shadow.mapSize);
    direct.shadow.camera.left = -shadow.extent;
    direct.shadow.camera.right = shadow.extent;
    direct.shadow.camera.top = shadow.extent;
    direct.shadow.camera.bottom = -shadow.extent;
    direct.shadow.camera.near = shadow.near;
    direct.shadow.camera.far = shadow.far;
    direct.shadow.bias = shadow.bias;
    direct.shadow.normalBias = shadow.normalBias;
    direct.shadow.camera.updateProjectionMatrix();
    scene.add(direct, direct.target);
  }
  context.renderer.toneMappingExposure = environment.exposure;

  const api: ReferenceApi = { ready: false, metadata: {} };
  (window as Window & { __solVisualReference?: ReferenceApi }).__solVisualReference = api;
  const terrainDiagnosticMaterial = diagnosticLayer === 'terrain-basic'
    ? new THREE.MeshBasicMaterial({ color: '#8a6b45' })
    : null;
  const classDebugMaterials = new WeakSet<THREE.Material>();
  let frames = 0;
  let settledFrames = 0;
  let terrainStableFrames = 0;
  let previousTerrainSignature = '';
  let previousFrameAt = performance.now();
  const frameTimes: number[] = [];
  const render = (): void => {
    const frameAt = performance.now();
    if (frames > 0) {
      frameTimes.push(frameAt - previousFrameAt);
      if (frameTimes.length > 600) frameTimes.shift();
    }
    previousFrameAt = frameAt;
    renderer.update(frame);
    if (secondaryRenderer && secondaryFrame) secondaryRenderer.update(secondaryFrame);
    if (diagnosticLayer === 'surface-class') {
      renderer.root.getObjectByName(`terrestrial-ocean:${station.bodyId}`)?.removeFromParent();
      renderer.root.getObjectByName(`terrestrial-cloud-deck:${station.bodyId}`)?.removeFromParent();
      renderer.root.getObjectByName(`terrestrial-atmosphere:${station.bodyId}`)?.removeFromParent();
      renderer.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (classDebugMaterials.has(material)
            || (!material.userData.terrestrialGlobal && !material.userData.terrestrialSurface)) continue;
          classDebugMaterials.add(material);
          const compile = material.onBeforeCompile.bind(material);
          material.onBeforeCompile = (
            shader: THREE.WebGLProgramParametersWithUniforms,
            rendererContext: THREE.WebGLRenderer,
          ) => {
            compile(shader, rendererContext);
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <opaque_fragment>',
              `float surfaceClassDebugCode = resolvedSurfaceClass(vBodyDirection);
vec3 surfaceClassDebugColor = surfaceClassDebugCode < 0.5 ? vec3(0.0)
  : abs(surfaceClassDebugCode - 1.0) < 0.25 ? vec3(0.36, 0.24, 0.10)
  : abs(surfaceClassDebugCode - 2.0) < 0.25 ? vec3(0.02, 0.22, 0.82)
  : abs(surfaceClassDebugCode - 3.0) < 0.25 ? vec3(0.04, 0.72, 0.78)
  : abs(surfaceClassDebugCode - 4.0) < 0.25 ? vec3(0.95, 0.56, 0.08)
  : abs(surfaceClassDebugCode - 5.0) < 0.25 ? vec3(0.22, 0.82, 0.96)
  : vec3(0.18, 0.72, 0.24);
outgoingLight = surfaceClassDebugColor;
#include <opaque_fragment>`,
            );
          };
          material.customProgramCacheKey = () => `surface-class-debug:${material.uuid}`;
          material.needsUpdate = true;
        }
      });
    } else if (diagnosticLayer === 'no-ocean') {
      renderer.root.getObjectByName(`terrestrial-ocean:${station.bodyId}`)?.removeFromParent();
    } else if (diagnosticLayer === 'no-clouds') {
      renderer.root.getObjectByName(`terrestrial-cloud-deck:${station.bodyId}`)?.removeFromParent();
    } else if (diagnosticLayer === 'no-weather') {
      renderer.root.getObjectByName(`terrestrial-cloud:${station.bodyId}:weather`)?.removeFromParent();
    } else if (diagnosticLayer === 'no-wisps') {
      renderer.root.getObjectByName(`terrestrial-cloud:${station.bodyId}:wisps`)?.removeFromParent();
    } else if (diagnosticLayer === 'no-atmosphere') {
      renderer.root.getObjectByName(`terrestrial-atmosphere:${station.bodyId}`)?.removeFromParent();
    } else if (diagnosticLayer === 'no-aerial') {
      renderer.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          const lighting = material.userData.terrestrialCloudLighting as
            | { atmosphereHeight?: { value: number } }
            | undefined;
          if (lighting?.atmosphereHeight) lighting.atmosphereHeight.value = 0;
        }
      });
    } else if (terrainDiagnosticMaterial) {
      renderer.root.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name.startsWith('terrain:')) {
          object.material = terrainDiagnosticMaterial;
        }
      });
    } else if (diagnosticLayer === 'clouds-only') {
      renderer.root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.visible = object.name.startsWith(`terrestrial-cloud:${station.bodyId}:`);
      });
    }
    context.renderer.render(scene, camera);
    frames++;
    const rendererStats = renderer.stats();
    const secondaryRendererStats = secondaryRenderer?.stats() ?? null;
    const detailSettled = !['requesting', 'reprojecting', 'crossfading'].includes(rendererStats.detailState ?? '')
      && !['requesting', 'reprojecting', 'crossfading'].includes(rendererStats.terrainDetailState ?? '');
    const coverageReady = station.presentation !== 'surface'
      || (rendererStats.coverageProgress ?? 0) >= 1;
    const terrainSignature = [
      rendererStats.chunks,
      rendererStats.visible,
      rendererStats.terrainTransitions ?? 0,
      Math.round((rendererStats.coverageProgress ?? 0) * 1_000),
    ].join(':');
    terrainStableFrames = terrainSignature === previousTerrainSignature ? terrainStableFrames + 1 : 0;
    previousTerrainSignature = terrainSignature;
    // High continues optional refinement around a fixed camera for a long
    // time. Once complete coverage has been held through four seconds of
    // nominal frames, capture even if off-screen/background children remain
    // queued; the sidecar preserves that pending count for review.
    const terrainSettled = station.presentation !== 'surface'
      || terrainStableFrames >= 30
      || frames >= 240;
    settledFrames = renderer.ready && (secondaryRenderer?.ready ?? true) && coverageReady && terrainSettled && detailSettled
      ? settledFrames + 1
      : 0;
    if (frames % 60 === 0) {
      api.metadata = Object.freeze({
        status: 'settling', frames, settledFrames, coverageReady, terrainSettled, detailSettled,
        terrainStableFrames, rendererReady: renderer.ready, rendererStats,
      });
    }
    if (frames >= 90 && settledFrames >= 30) {
      const info = context.renderer.info;
      const gl = context.renderer.getContext();
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const sortedFrameTimes = [...frameTimes].sort((a, b) => a - b);
      const percentile = (fraction: number): number => sortedFrameTimes.length === 0
        ? 0
        : sortedFrameTimes[Math.min(sortedFrameTimes.length - 1, Math.floor(sortedFrameTimes.length * fraction))];
      api.ready = true;
      api.metadata = Object.freeze({
        station,
        referenceTimeSeconds,
        quality,
        diagnosticLayer,
        viewport: [innerWidth, innerHeight],
        drawingBuffer: context.renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(),
        dpr: devicePixelRatio,
        manifestDigest: checkedPlanetArtifact.manifestSha256,
        toneMapping: 'ACESFilmic',
        exposure: context.renderer.toneMappingExposure,
        shadows: context.renderer.shadowMap.enabled,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
        gpu: debugInfo ? {
          vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
        } : { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) },
        frameTimeMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
        aerialConsumers: rendererStats.aerialConsumers ?? [],
        settledFrames,
        capturedAfterFrames: frames,
        rendererStats,
        secondaryRendererStats,
        scaleAuthority: SOL_CONSTANTS_SOURCE_SHA256,
      });
    }
    requestAnimationFrame(render);
  };
  render();
}
