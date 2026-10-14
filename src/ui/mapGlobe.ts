import * as THREE from 'three';
import { BODY_VISUALS, type BodyId, type CompactPlanetVisualDef } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import type { QualityTier, RuntimeBodyAssetPack } from '../render/bodyRenderer';
import {
  applyAtmosphereScatteringProfile,
  createAtmosphereScatteringState,
  type AtmosphereScatteringProfile,
  type AtmosphereScatteringState,
} from '../render/atmosphereScattering';
import {
  createCompactAtmosphereMaterial,
  createCompactAtmosphereScattering,
  createCompactShadingState,
  createCompactSurfaceMaterial,
  type CompactShadingState,
} from '../render/compactPlanetBodyRenderer';
import { bodyScatteringProfile, updateTerrestrialAerialPerspective } from '../render/terrestrial/aerialPerspective';
import { createCloudMaterial } from '../render/terrestrial/cloudMaterial';
import { WEATHER_CLOUD_DRIFT_RATE } from '../render/terrestrial/cloudLayer';
import { updateTerrestrialCloudLighting } from '../render/terrestrial/globalMaterial';

/**
 * Map globes are a few dozen pixels across, where a physical 100 km haze is a
 * single pixel. Thicken atmospheres for the map while keeping their vertical
 * optical depth, so the limb reads without washing out the disk.
 */
export const MAP_ATMOSPHERE_EXAGGERATION = 3;

/** Draw order below map markers and labels (sprites use 10). */
const MAP_CLOUD_RENDER_ORDER = 6;
const MAP_ATMOSPHERE_RENDER_ORDER = 5;

export interface MapGlobeState {
  readonly shading: CompactShadingState;
  readonly radius: number;
  readonly atmosphere: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  readonly clouds: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
}

function compactVisual(bodyId: string): Readonly<CompactPlanetVisualDef> | undefined {
  const visual = BODY_VISUALS[bodyId as BodyId];
  return visual?.compactPlanetVisual ?? visual?.gasGiantVisual;
}

/**
 * Flight-view photometry for an albedo-only globe on the map, or null when the
 * body has no compact visual definition (legacy palette bodies).
 */
export function createMapCompactSurfaceMaterial(
  bodyId: string,
  pack: Readonly<RuntimeBodyAssetPack>,
  shading: CompactShadingState,
): THREE.ShaderMaterial | null {
  const visual = compactVisual(bodyId);
  const albedo = pack.textures.get('albedo');
  if (!visual || !albedo) return null;
  const photometry = visual.photometry
    ?? (BODY_VISUALS[bodyId as BodyId]?.renderer === 'gas-giant' ? 'gas-giant' : 'airless');
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.needsUpdate = true;
  const material = createCompactSurfaceMaterial(albedo, photometry, visual, shading);
  // The map always renders globes opaque.
  material.transparent = false;
  return material;
}

function exaggeratedProfile(
  profile: Readonly<AtmosphereScatteringProfile>,
  factor: number,
): AtmosphereScatteringProfile {
  const thin = (values: readonly [number, number, number]) =>
    values.map((value) => value / factor) as unknown as readonly [number, number, number];
  return {
    ...profile,
    height: profile.height * factor,
    rayleighScaleHeight: profile.rayleighScaleHeight * factor,
    mieScaleHeight: profile.mieScaleHeight * factor,
    rayleigh: thin(profile.rayleigh),
    mieScattering: thin(profile.mieScattering),
    mieExtinction: thin(profile.mieExtinction),
    absorption: thin(profile.absorption),
  };
}

function mapAtmosphereScattering(body: Readonly<Body>): {
  readonly scattering: AtmosphereScatteringState;
  readonly profile: AtmosphereScatteringProfile | null;
} | null {
  const terrestrial = bodyScatteringProfile(body);
  if (terrestrial && BODY_VISUALS[body.id as BodyId]?.atmosphereVisual) {
    const profile = exaggeratedProfile(terrestrial, MAP_ATMOSPHERE_EXAGGERATION);
    const scattering = createAtmosphereScatteringState();
    applyAtmosphereScatteringProfile(scattering, profile);
    return { scattering, profile };
  }
  const compact = compactVisual(body.id)?.atmosphere;
  if (!compact) return null;
  return {
    scattering: createCompactAtmosphereScattering(body.equatorialRadius, compact, MAP_ATMOSPHERE_EXAGGERATION),
    profile: null,
  };
}

/**
 * Attach the flight view's atmosphere shell and (for authored terrestrial
 * bodies) its cloud deck to a map globe. Children share the globe's unit
 * geometry and inherit its presentation scale and body orientation.
 */
export function dressMapGlobe(
  mesh: THREE.Mesh,
  body: Readonly<Body>,
  pack: Readonly<RuntimeBodyAssetPack> | null,
  quality: QualityTier,
): MapGlobeState {
  const shading = (mesh.userData.mapShading as CompactShadingState | undefined) ?? createCompactShadingState();
  const atmosphereSetup = pack ? mapAtmosphereScattering(body) : null;
  let atmosphere: MapGlobeState['atmosphere'] = null;
  let clouds: MapGlobeState['clouds'] = null;
  if (atmosphereSetup) {
    const material = createCompactAtmosphereMaterial(atmosphereSetup.scattering, shading, quality);
    atmosphere = new THREE.Mesh(mesh.geometry, material);
    atmosphere.name = `map-atmosphere:${body.id}`;
    atmosphere.scale.setScalar(atmosphereSetup.scattering.topRadius.value);
    atmosphere.renderOrder = MAP_ATMOSPHERE_RENDER_ORDER;
    atmosphere.raycast = () => {};
    mesh.add(atmosphere);
  }
  const cloudTexture = pack?.textures.get('clouds');
  if (cloudTexture && atmosphereSetup?.profile && body.def.atmosphere) {
    const profile = atmosphereSetup.profile;
    const shellRadius = body.radius + profile.height * 0.11;
    const material = createCloudMaterial(cloudTexture, {
      textureScale: 1,
      opacity: 0.92,
      tint: '#e9edf0',
      shellRadius,
      parallaxStrength: 0.006,
      scattering: profile,
    });
    material.name = 'map-cloud-deck';
    clouds = new THREE.Mesh(mesh.geometry, material);
    clouds.name = `map-clouds:${body.id}`;
    clouds.scale.setScalar(shellRadius / body.radius);
    clouds.renderOrder = MAP_CLOUD_RENDER_ORDER;
    clouds.raycast = () => {};
    mesh.add(clouds);
  }
  const state: MapGlobeState = Object.freeze({ shading, radius: body.radius, atmosphere, clouds });
  mesh.userData.mapGlobe = state;
  return state;
}

const _localCamera = new THREE.Vector3();
const _sunBodyFixed = new THREE.Vector3();
const _inverseOrientation = new THREE.Quaternion();
const _drift = new THREE.Quaternion();
const _inverseDrift = new THREE.Quaternion();
const _cloudVector = new THREE.Vector3();
const DRIFT_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Express the camera and Sun in the globe's own frame. Dividing by the
 * presentation scale maps the (possibly oblate) globe to a unit sphere, which
 * is the space every compact shader and shell integrates in.
 */
export function updateMapGlobe(
  mesh: THREE.Mesh,
  body: Readonly<Body>,
  cameraWorld: Readonly<THREE.Vector3>,
  sunWorldDirection: Readonly<THREE.Vector3>,
  time: number,
): void {
  mesh.updateMatrixWorld();
  _localCamera.copy(cameraWorld);
  mesh.worldToLocal(_localCamera);
  _inverseOrientation.copy(mesh.quaternion).invert();
  _sunBodyFixed.copy(sunWorldDirection).applyQuaternion(_inverseOrientation).normalize();

  const state = mesh.userData.mapGlobe as MapGlobeState | undefined;
  const shading = state?.shading ?? (mesh.userData.mapShading as CompactShadingState | undefined);
  if (shading) {
    shading.sunDirection.value.copy(_sunBodyFixed);
    shading.cameraUnit.value.copy(_localCamera);
  }

  const driftAngle = time * WEATHER_CLOUD_DRIFT_RATE;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    // Both terrestrial programs compare the Sun against body-fixed directions.
    updateTerrestrialCloudLighting(material, _sunBodyFixed, driftAngle);
    if (material.userData.terrestrialGlobal && body.def.atmosphere) {
      updateTerrestrialAerialPerspective(material, body, {
        cameraBodyFixed: {
          x: _localCamera.x * body.radius,
          y: _localCamera.y * body.radius,
          z: _localCamera.z * body.radius,
        },
        bodySunDirection: _sunBodyFixed,
        solarVisibleFraction: 1,
      });
    }
  }

  const clouds = state?.clouds;
  if (clouds) {
    _drift.setFromAxisAngle(DRIFT_AXIS, driftAngle);
    clouds.quaternion.copy(_drift);
    _inverseDrift.copy(_drift).invert();
    const uniforms = clouds.material.uniforms;
    _cloudVector.copy(_localCamera).multiplyScalar(state.radius).applyQuaternion(_inverseDrift);
    (uniforms.uCameraCloudFixed.value as THREE.Vector3).copy(_cloudVector);
    (uniforms.uSunDirection.value as THREE.Vector3).copy(_sunBodyFixed);
    _cloudVector.copy(_sunBodyFixed).applyQuaternion(_inverseDrift);
    (uniforms.uSunCloudFixed.value as THREE.Vector3).copy(_cloudVector);
    uniforms.uTime.value = time;
  }
}

/** Release a map globe and its shells; textures stay pack-owned. */
export function disposeMapGlobe(mesh: THREE.Mesh): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  mesh.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
