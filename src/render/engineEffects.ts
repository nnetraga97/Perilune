/**
 * Shared real-time engine flame resources. The meshes provide a stable plume
 * silhouette while the shader supplies the fast detail (flicker, turbulence,
 * and pressure-visible shock cells) without a particle draw call per engine.
 */
import * as THREE from 'three';

export interface EnginePlumeLayers {
  readonly group: THREE.Group;
  readonly baseScale: number;
}

const sharedGeometries = {
  sheath: makePlumeGeometry(0.09, 0.48, 4.2, 18, 9),
  flame: makePlumeGeometry(0.05, 0.27, 3.05, 16, 7),
  core: makePlumeGeometry(0.025, 0.13, 1.75, 14, 5),
};

function makePlumeGeometry(
  nozzleRadius: number,
  exhaustRadius: number,
  length: number,
  radialSegments: number,
  heightSegments: number,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(
    nozzleRadius,
    exhaustRadius,
    length,
    radialSegments,
    heightSegments,
    true,
  );
  // Put the top of every layer exactly on the authored nozzle exit.
  geometry.translate(0, -length / 2, 0);
  return geometry;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uTurbulence;
  varying float vAxial;
  varying float vPulse;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    vUv = uv;
    // CylinderGeometry runs from y=0 at the nozzle to negative y downstream.
    vAxial = clamp(-position.y / 4.2, 0.0, 1.0);
    float phase = uTime * 11.0 + position.y * 4.7 + hash21(uv * 17.0) * 6.28318;
    vPulse = 0.82 + 0.18 * sin(phase);
    vec3 displaced = position;
    float flutter = sin(phase * 0.71) * cos(phase * 1.13 + uv.x * 12.0);
    displaced.xz *= 1.0 + flutter * uTurbulence * smoothstep(0.08, 1.0, vAxial);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uHotColor;
  uniform vec3 uCoolColor;
  uniform float uOpacity;
  uniform float uShockStrength;
  uniform float uLayerLength;
  varying float vAxial;
  varying float vPulse;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  void main() {
    float axial = clamp(vAxial * uLayerLength, 0.0, 1.0);
    float ignition = smoothstep(0.0, 0.025, axial);
    float tip = 1.0 - smoothstep(0.58, 1.0, axial);
    float edgeNoise = hash21(vec2(floor(vUv.x * 28.0), floor((axial + uTime * 0.7) * 30.0)));
    float turbulence = mix(0.72, 1.08, edgeNoise) * vPulse;

    // Bright stationary compression bands read as shock diamonds. Their
    // intensity is pressure-controlled by the runtime.
    float shockWave = max(0.0, sin(axial * 51.0 - 1.2));
    float shockEnvelope = smoothstep(0.06, 0.18, axial) * (1.0 - smoothstep(0.62, 0.82, axial));
    float shocks = pow(shockWave, 7.0) * shockEnvelope * uShockStrength;

    vec3 color = mix(uHotColor, uCoolColor, smoothstep(0.04, 0.92, axial));
    color += uHotColor * shocks * 1.5;
    float alpha = uOpacity * ignition * tip * turbulence * (1.0 + shocks * 0.65);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

interface PlumePalette {
  hot: string;
  cool: string;
  opacity: number;
  turbulence: number;
}

function makeMaterial(palette: PlumePalette, layerLength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTurbulence: { value: palette.turbulence },
      uHotColor: { value: new THREE.Color(palette.hot) },
      uCoolColor: { value: new THREE.Color(palette.cool) },
      uOpacity: { value: palette.opacity },
      uShockStrength: { value: 0 },
      uLayerLength: { value: layerLength },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function makePalette(solid: boolean): readonly THREE.ShaderMaterial[] {
  if (solid) {
    return [
      makeMaterial({ hot: '#ffb45a', cool: '#ff4b12', opacity: 0.34, turbulence: 0.12 }, 1),
      makeMaterial({ hot: '#fff3bf', cool: '#ff8a22', opacity: 0.56, turbulence: 0.075 }, 4.2 / 3.05),
      makeMaterial({ hot: '#fffef4', cool: '#ffd47c', opacity: 0.82, turbulence: 0.035 }, 4.2 / 1.75),
    ];
  }
  return [
    makeMaterial({ hot: '#8ed8ff', cool: '#526dff', opacity: 0.28, turbulence: 0.105 }, 1),
    makeMaterial({ hot: '#e9fbff', cool: '#79a9ff', opacity: 0.53, turbulence: 0.065 }, 4.2 / 3.05),
    makeMaterial({ hot: '#ffffff', cool: '#bcecff', opacity: 0.86, turbulence: 0.025 }, 4.2 / 1.75),
  ];
}

const liquidMaterials = makePalette(false);
const solidMaterials = makePalette(true);
const allMaterials = [...liquidMaterials, ...solidMaterials];

export function buildEnginePlumeLayers(baseScale: number, solid: boolean): EnginePlumeLayers {
  const group = new THREE.Group();
  group.name = solid ? 'srb-flame-layers' : 'engine-flame-layers';
  const materials = solid ? solidMaterials : liquidMaterials;
  group.add(
    new THREE.Mesh(sharedGeometries.sheath, materials[0]),
    new THREE.Mesh(sharedGeometries.flame, materials[1]),
    new THREE.Mesh(sharedGeometries.core, materials[2]),
  );
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.frustumCulled = false;
  });
  group.userData.effectLayer = 'flame';
  return { group, baseScale };
}

/** Shared uniforms mean all engine plume meshes animate in two material sets. */
export function updateEngineEffectMaterials(time: number, pressureFrac: number): void {
  const pressure = THREE.MathUtils.clamp(pressureFrac, 0, 1);
  for (const material of allMaterials) {
    material.uniforms.uTime.value = time;
    material.uniforms.uShockStrength.value = THREE.MathUtils.smoothstep(pressure, 0.08, 0.8);
  }
}
