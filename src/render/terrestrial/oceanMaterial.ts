import * as THREE from 'three';
import type { QualityTier } from '../bodyRenderer';

const GLITTER_BY_QUALITY: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 0.16,
  medium: 0.56,
  high: 0.9,
});

const CAP_SEGMENTS_BY_QUALITY: Readonly<Record<QualityTier, number>> = Object.freeze({
  // Even Low stays dense enough for sub-metre chord error through the 5.5 km
  // low-flight presentation checkpoint. This is one mesh and one draw call.
  low: 144,
  medium: 160,
  high: 192,
});

const MAXIMUM_CAP_ANGLE_RADIANS = 0.55;
const HORIZON_MARGIN_RATIO = 1.25;
const HORIZON_MARGIN_RADIANS = 0.005;

function configureShoreMask(shoreMask: THREE.Texture | null): void {
  if (!shoreMask) return;
  shoreMask.colorSpace = THREE.NoColorSpace;
  shoreMask.wrapS = THREE.RepeatWrapping;
  shoreMask.wrapT = THREE.ClampToEdgeWrapping;
}

export function oceanCapSegments(quality: QualityTier): number {
  return CAP_SEGMENTS_BY_QUALITY[quality];
}

/**
 * Angular radius of the circle inscribed in the square gnomonic patch.
 * The margin keeps the geometric horizon away from the patch boundary while
 * the cap is recentered on the camera every frame.
 */
export function oceanCapAngle(bodyRadius: number, altitudeMeters: number): number {
  if (!(bodyRadius > 0) || !Number.isFinite(bodyRadius)) throw new Error(`Invalid ocean radius ${bodyRadius}`);
  const altitude = Number.isFinite(altitudeMeters) ? Math.max(0, altitudeMeters) : 0;
  const horizon = Math.acos(Math.min(1, bodyRadius / (bodyRadius + altitude)));
  return Math.min(
    MAXIMUM_CAP_ANGLE_RADIANS,
    horizon * HORIZON_MARGIN_RATIO + HORIZON_MARGIN_RADIANS,
  );
}

/** Mirror of the cap vertex shader for geometry tests and CPU-side bounds. */
export function oceanCapDirection(
  anchor: Readonly<{ x: number; y: number; z: number }>,
  east: Readonly<{ x: number; y: number; z: number }>,
  north: Readonly<{ x: number; y: number; z: number }>,
  gridX: number,
  gridY: number,
  capAngle: number,
): Readonly<{ x: number; y: number; z: number }> {
  const extent = Math.tan(capAngle);
  const x = anchor.x + (gridX * east.x + gridY * north.x) * extent;
  const y = anchor.y + (gridX * east.y + gridY * north.y) * extent;
  const z = anchor.z + (gridX * east.z + gridY * north.z) * extent;
  const length = Math.hypot(x, y, z) || 1;
  return Object.freeze({ x: x / length, y: y / length, z: z / length });
}

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uShoreMask;
  uniform float uHasShoreMask;
  uniform vec3 uOceanColor;
  uniform float uBodyRadius;
  uniform vec3 uCameraBodyFixed;
  uniform vec3 uSunDirection;
  uniform float uGlitterStrength;
  uniform float uTime;
  varying vec3 vBodyDirection;
  varying vec3 vViewNormal;
  varying vec3 vViewDirection;

  vec2 bodyUv(vec3 direction) {
    float longitude = atan(direction.y, direction.x) / 6.283185307179586;
    return vec2(longitude < 0.0 ? longitude + 1.0 : longitude,
      0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793);
  }

  void main() {
    float oceanMask = uHasShoreMask > 0.5 ? texture2D(uShoreMask, bodyUv(vBodyDirection)).a : 1.0;
    if (uHasShoreMask > 0.5 && oceanMask <= 0.01) discard;
    #include <logdepthbuf_fragment>
    float shore = 1.0 - abs(oceanMask * 2.0 - 1.0);
    float fresnel = pow(1.0 - max(0.0, dot(normalize(vViewNormal), normalize(vViewDirection))), 4.0);
    vec3 reflectedSun = reflect(-normalize(uSunDirection), normalize(vBodyDirection));
    vec3 bodyView = normalize(uCameraBodyFixed - vBodyDirection * uBodyRadius);
    float wave = sin(vBodyDirection.x * 170.0 + uTime * 0.7) *
      sin(vBodyDirection.y * 143.0 - uTime * 0.53);
    float glitter = pow(max(0.0, dot(reflectedSun, bodyView)), 96.0) *
      (0.55 + 0.45 * wave) * uGlitterStrength;
    vec3 depthTint = mix(uOceanColor * 0.48, uOceanColor * 1.18, fresnel);
    vec3 foam = vec3(0.72, 0.82, 0.84) * shore;
    gl_FragColor = vec4(depthTint + foam * 0.72 + glitter, 1.0);
  }
`;

export function createOceanCapMaterial(
  quality: QualityTier,
  shoreMask: THREE.Texture | null,
  oceanColor: THREE.ColorRepresentation,
  bodyRadius: number,
): THREE.ShaderMaterial {
  configureShoreMask(shoreMask);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uShoreMask: { value: shoreMask },
      uHasShoreMask: { value: shoreMask ? 1 : 0 },
      uOceanColor: { value: new THREE.Color(oceanColor) },
      uBodyRadius: { value: bodyRadius },
      uCameraBodyFixed: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uGlitterStrength: { value: GLITTER_BY_QUALITY[quality] },
      uTime: { value: 0 },
      uAnchorDirection: { value: new THREE.Vector3(0, 0, 1) },
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uNorth: { value: new THREE.Vector3(0, 1, 0) },
      uCapAngle: { value: HORIZON_MARGIN_RADIANS },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 uAnchorDirection;
      uniform vec3 uEast;
      uniform vec3 uNorth;
      uniform float uCapAngle;
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        float extent = tan(uCapAngle);
        vec3 direction = normalize(
          uAnchorDirection + (position.x * uEast + position.y * uNorth) * extent
        );
        vBodyDirection = direction;
        vec4 viewPosition = modelViewMatrix * vec4(direction, 1.0);
        vViewNormal = normalize(normalMatrix * direction);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    // Water is independently tinted, but it is the authoritative depth
    // surface. Blending the raw seafloor through it creates a second ground.
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  material.name = `terrestrial-ocean-cap:${quality}`;
  material.userData.quality = quality;
  material.userData.shoreMaskFallback = shoreMask === null;
  material.userData.oceanCap = true;
  return material;
}
