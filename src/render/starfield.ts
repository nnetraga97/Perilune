import * as THREE from 'three';

const STARFIELD_RADIUS = 5e8;
const BAND_STAR_FRACTION = 0.18;
const WARM_STAR = new THREE.Color('#f1e5d5');
const NEUTRAL_STAR = new THREE.Color('#e9edf2');
const COOL_STAR = new THREE.Color('#dce8f4');

const vertexShader = /* glsl */ `
  attribute float pointSize;
  attribute vec3 color;
  uniform float pixelRatio;
  varying vec3 vColor;

  void main() {
    vColor = color;
    // Rotation-only view keeps the sphere infinitely distant. Pinning depth to
    // the far plane also keeps the same field visible for flight and map
    // cameras, which intentionally use different physical clipping ranges.
    vec4 clipPosition = projectionMatrix * vec4(mat3(modelViewMatrix) * position, 1.0);
    gl_Position = clipPosition.xyww;
    gl_PointSize = pointSize * pixelRatio;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float radiusSquared = dot(centered, centered);
    float alpha = 1.0 - smoothstep(0.07, 0.25, radiusSquared);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Deterministic, texture-free points on a far sphere. Most stars remain faint
 * and close to one pixel, with a sparse brighter population and a restrained
 * fixed-plane density band. The result is still one THREE.Points draw call.
 */
export function makeStarfield(count = 4000, seed = 12345): THREE.Points {
  const starCount = Math.max(0, Math.floor(count));
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const pointSizes = new Float32Array(starCount);
  let s = (seed | 0) || 0x6d2b79f5;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };

  // Fixed rotations keep the denser plane from aligning with a scene axis.
  const tiltX = 0.49;
  const tiltZ = -0.31;
  const cosX = Math.cos(tiltX);
  const sinX = Math.sin(tiltX);
  const cosZ = Math.cos(tiltZ);
  const sinZ = Math.sin(tiltZ);

  for (let i = 0; i < starCount; i++) {
    let x: number;
    let y: number;
    let z: number;
    if (rand() < BAND_STAR_FRACTION) {
      const longitude = rand() * Math.PI * 2;
      // Four samples produce a soft concentration around a narrow great-circle
      // band while retaining enough width to avoid a drawn stripe.
      const latitude = (rand() + rand() + rand() + rand() - 2) * 0.13;
      const cosLatitude = Math.cos(latitude);
      x = Math.cos(longitude) * cosLatitude;
      y = Math.sin(latitude);
      z = Math.sin(longitude) * cosLatitude;

      const rotatedY = y * cosX - z * sinX;
      const rotatedZ = y * sinX + z * cosX;
      const rotatedX = x * cosZ - rotatedY * sinZ;
      y = x * sinZ + rotatedY * cosZ;
      x = rotatedX;
      z = rotatedZ;
    } else {
      z = rand() * 2 - 1;
      const longitude = rand() * Math.PI * 2;
      const radiusXY = Math.sqrt(Math.max(0, 1 - z * z));
      x = Math.cos(longitude) * radiusXY;
      y = Math.sin(longitude) * radiusXY;
    }

    positions[i * 3] = x * STARFIELD_RADIUS;
    positions[i * 3 + 1] = y * STARFIELD_RADIUS;
    positions[i * 3 + 2] = z * STARFIELD_RADIUS;

    const prominence = rand();
    let pointSize: number;
    let brightness: number;
    if (prominence < 0.012) {
      pointSize = 1.65 + rand() * 0.55;
      brightness = 0.82 + rand() * 0.18;
    } else if (prominence < 0.1) {
      pointSize = 1.12 + rand() * 0.42;
      brightness = 0.5 + rand() * 0.24;
    } else {
      pointSize = 0.72 + rand() * 0.38;
      brightness = 0.27 + Math.pow(rand(), 2) * 0.27;
    }
    pointSizes[i] = pointSize;

    const temperature = rand();
    const tint = temperature < 0.16
      ? WARM_STAR
      : temperature > 0.84 ? COOL_STAR : NEUTRAL_STAR;
    colors[i * 3] = tint.r * brightness;
    colors[i * 3 + 1] = tint.g * brightness;
    colors[i * 3 + 2] = tint.b * brightness;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('pointSize', new THREE.BufferAttribute(pointSizes, 1));
  const mat = new THREE.ShaderMaterial({
    name: 'procedural-space-starfield',
    uniforms: { pixelRatio: { value: 1 } },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'procedural-space-starfield';
  points.frustumCulled = false;
  points.renderOrder = -10;
  points.onBeforeRender = (renderer) => {
    mat.uniforms.pixelRatio.value = Math.min(2, renderer.getPixelRatio());
  };
  return points;
}
