import * as THREE from 'three';

export interface CloudMaterialOptions {
  readonly textureScale: number;
  readonly opacity: number;
  readonly tint: THREE.ColorRepresentation;
}

export function createCloudMaterial(
  cloudTexture: THREE.Texture,
  options: Readonly<CloudMaterialOptions>,
): THREE.ShaderMaterial {
  cloudTexture.colorSpace = THREE.NoColorSpace;
  cloudTexture.wrapS = THREE.RepeatWrapping;
  cloudTexture.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCloudMap: { value: cloudTexture },
      uTextureScale: { value: options.textureScale },
      uOpacity: { value: options.opacity },
      uTint: { value: new THREE.Color(options.tint) },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyDirection = normalize(position);
        vViewNormal = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uCloudMap;
      uniform float uTextureScale;
      uniform float uOpacity;
      uniform vec3 uTint;
      uniform vec3 uSunDirection;
      uniform float uTime;
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;

      vec2 cloudUv(vec3 direction) {
        float longitude = atan(direction.y, direction.x) / 6.283185307179586;
        float u = longitude < 0.0 ? longitude + 1.0 : longitude;
        float v = 0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793;
        return vec2(fract(u * uTextureScale), v);
      }

      void main() {
        vec2 field = texture2D(uCloudMap, cloudUv(vBodyDirection)).rg;
        float coverage = smoothstep(0.08, 0.92, field.r);
        float opticalDepth = field.g;
        float day = 0.3 + 0.7 * max(0.0, dot(normalize(vBodyDirection), normalize(uSunDirection)));
        float silver = pow(1.0 - max(0.0, dot(normalize(vViewNormal), normalize(vViewDirection))), 3.0);
        vec3 color = uTint * (0.38 + day * 0.72) + silver * vec3(0.34);
        float alpha = coverage * mix(0.28, 1.0, opticalDepth) * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  return material;
}

/** Alpha-aware shadow pass; avoids an opaque planet-sized cloud shadow. */
export function createCloudShadowMaterial(
  cloudTexture: THREE.Texture,
  textureScale: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCloudMap: { value: cloudTexture },
      uTextureScale: { value: textureScale },
    },
    vertexShader: /* glsl */ `
      varying vec3 vBodyDirection;
      void main() {
        vBodyDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D uCloudMap;
      uniform float uTextureScale;
      varying vec3 vBodyDirection;
      void main() {
        float longitude = atan(vBodyDirection.y, vBodyDirection.x) / 6.283185307179586;
        float u = longitude < 0.0 ? longitude + 1.0 : longitude;
        float v = 0.5 - asin(clamp(vBodyDirection.z, -1.0, 1.0)) / 3.141592653589793;
        vec2 field = texture2D(uCloudMap, vec2(fract(u * uTextureScale), v)).rg;
        if (field.r * field.g < 0.08) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }
    `,
    depthWrite: true,
    depthTest: true,
  });
}
