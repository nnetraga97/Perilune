import * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { BodyRenderFrame, QuaternionCoordinates, VectorCoordinates } from './bodyRenderer';
import {
  atmospherePresentationVisibility,
  bindTerrestrialAerialPerspectiveUniforms,
  createTerrestrialAerialPerspectiveState,
  TERRESTRIAL_AERIAL_FRAGMENT_GLSL,
  type TerrestrialAerialPerspectiveState,
} from './terrestrial/aerialPerspective';

export const FLIGHT_AERIAL_USER_DATA_KEY = 'flightAerialPerspective' as const;
const FLIGHT_AERIAL_PROGRAM_VERSION = 'flight-aerial-v1';

export interface FlightAerialPerspectiveSnapshot {
  readonly active: boolean;
  readonly bodyId: string | null;
  readonly cameraBodyFixed: readonly [number, number, number];
  readonly worldToBody: readonly number[];
}

/** One mutable aerial state owner per WorldScene. */
export class FlightAerialPerspectiveController {
  readonly aerial: TerrestrialAerialPerspectiveState =
    createTerrestrialAerialPerspectiveState('flight-solids');
  readonly active = { value: 0 };
  readonly worldToBody = { value: new THREE.Matrix3().identity() };
  private bodyId: string | null = null;
  private readonly inverseOrientation = new THREE.Quaternion();
  private readonly rotation = new THREE.Matrix4();
  private disposed = false;

  update(
    body: Readonly<Body>,
    frame: Pick<BodyRenderFrame,
      'cameraBodyFixed' | 'bodySunDirection' | 'solarVisibleFraction' | 'orientation'>,
    lookup?: THREE.Texture,
  ): void {
    if (this.disposed) return;
    const atmosphere = body.def.atmosphere;
    this.bodyId = body.id;
    this.active.value = atmosphere ? 1 : 0;
    this.aerial.cameraBodyFixed.value.set(
      frame.cameraBodyFixed.x,
      frame.cameraBodyFixed.y,
      frame.cameraBodyFixed.z,
    );
    this.aerial.bodyRadius.value = body.radius;
    this.aerial.atmosphereHeight.value = atmosphere?.height ?? 0;
    this.aerial.scaleHeight.value = atmosphere?.scaleHeight ?? 1;
    this.aerial.sunDirection.value.set(
      frame.bodySunDirection.x,
      frame.bodySunDirection.y,
      frame.bodySunDirection.z,
    ).normalize();
    this.aerial.solarVisibleFraction.value = THREE.MathUtils.clamp(
      frame.solarVisibleFraction,
      0,
      1,
    );
    const cameraAltitude = Math.max(0, this.aerial.cameraBodyFixed.value.length() - body.radius);
    this.aerial.presentationVisibility.value = atmospherePresentationVisibility(
      cameraAltitude,
      atmosphere?.height ?? 0,
    );
    this.aerial.lookup.value = atmosphere ? lookup ?? null : null;
    this.aerial.useLookup.value = atmosphere && lookup ? 1 : 0;
    this.setInverseOrientation(frame.orientation);
  }

  disable(
    body: Readonly<Body>,
    frame: Pick<BodyRenderFrame, 'cameraBodyFixed' | 'bodySunDirection' | 'solarVisibleFraction' | 'orientation'>,
  ): void {
    this.update(body, frame);
    this.active.value = 0;
    this.aerial.atmosphereHeight.value = 0;
    this.aerial.presentationVisibility.value = 0;
    this.aerial.lookup.value = null;
    this.aerial.useLookup.value = 0;
  }

  private setInverseOrientation(orientation: Readonly<QuaternionCoordinates>): void {
    this.inverseOrientation.set(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    ).normalize().invert();
    this.rotation.makeRotationFromQuaternion(this.inverseOrientation);
    this.worldToBody.value.setFromMatrix4(this.rotation);
  }

  snapshot(): FlightAerialPerspectiveSnapshot {
    return Object.freeze({
      active: this.active.value > 0.5,
      bodyId: this.bodyId,
      cameraBodyFixed: Object.freeze(this.aerial.cameraBodyFixed.value.toArray()),
      worldToBody: Object.freeze(this.worldToBody.value.toArray()),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bodyId = null;
    this.active.value = 0;
    this.aerial.atmosphereHeight.value = 0;
    this.aerial.presentationVisibility.value = 0;
    this.aerial.lookup.value = null;
    this.aerial.useLookup.value = 0;
  }
}

/** CPU mirror of the shader's camera-relative world-to-body reconstruction. */
export function flightWorldPointToBodyFixed(
  cameraBodyFixed: Readonly<VectorCoordinates>,
  worldToBody: Readonly<THREE.Matrix3>,
  cameraRelativeWorldPosition: Readonly<VectorCoordinates>,
): THREE.Vector3 {
  return new THREE.Vector3(
    cameraRelativeWorldPosition.x,
    cameraRelativeWorldPosition.y,
    cameraRelativeWorldPosition.z,
  ).applyMatrix3(worldToBody as THREE.Matrix3).add(new THREE.Vector3(
    cameraBodyFixed.x,
    cameraBodyFixed.y,
    cameraBodyFixed.z,
  ));
}

function injectFlightAerialShader(
  material: THREE.Material,
  controller: FlightAerialPerspectiveController,
): void {
  const attached = material.userData[FLIGHT_AERIAL_USER_DATA_KEY] as
    | FlightAerialPerspectiveController
    | undefined;
  if (attached === controller) return;
  if (attached) throw new Error('Material already belongs to another flight aerial controller');
  const previousCompile = material.onBeforeCompile.bind(material);
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.userData[FLIGHT_AERIAL_USER_DATA_KEY] = controller;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    bindTerrestrialAerialPerspectiveUniforms(shader, controller.aerial);
    shader.uniforms.flightAerialEnabled = controller.active;
    shader.uniforms.flightAerialWorldToBody = controller.worldToBody;
    if (!shader.vertexShader.includes('#include <worldpos_vertex>')
      || !shader.fragmentShader.includes('#include <opaque_fragment>')) {
      throw new Error(`${material.type} lacks flight aerial shader anchors`);
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFlightAerialWorldPosition;',
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 flightAerialWorldPosition4 = vec4(transformed, 1.0);
#ifdef USE_BATCHING
  flightAerialWorldPosition4 = batchingMatrix * flightAerialWorldPosition4;
#endif
#ifdef USE_INSTANCING
  flightAerialWorldPosition4 = instanceMatrix * flightAerialWorldPosition4;
#endif
flightAerialWorldPosition4 = modelMatrix * flightAerialWorldPosition4;
vFlightAerialWorldPosition = flightAerialWorldPosition4.xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vFlightAerialWorldPosition;\nuniform float flightAerialEnabled;\nuniform mat3 flightAerialWorldToBody;\n${TERRESTRIAL_AERIAL_FRAGMENT_GLSL}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `vec3 flightAerialPointBodyFixed = terrestrialAerialCameraBodyFixed
  + flightAerialWorldToBody * vFlightAerialWorldPosition;
vec3 flightAerialColor = applyTerrestrialAerialPerspective(
  flightAerialPointBodyFixed,
  outgoingLight
);
outgoingLight = mix(outgoingLight, flightAerialColor, flightAerialEnabled);
#include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => `${previousCacheKey()}:${FLIGHT_AERIAL_PROGRAM_VERSION}`;
  material.needsUpdate = true;
}

/** Bind a scene-owned material in place; use only when that material is not shared. */
export function bindFlightAerialPerspective(
  material: THREE.Material,
  controller: FlightAerialPerspectiveController,
): void {
  injectFlightAerialShader(material, controller);
}

/** Clone material state while continuing to borrow every referenced texture. */
export function createFlightAerialMaterialVariant<T extends THREE.Material>(
  base: T,
  controller: FlightAerialPerspectiveController,
): T {
  const variant = base.clone() as T;
  // Material.clone() does not promise to carry application shader hooks.
  variant.onBeforeCompile = base.onBeforeCompile;
  variant.customProgramCacheKey = base.customProgramCacheKey;
  injectFlightAerialShader(variant, controller);
  return variant;
}
