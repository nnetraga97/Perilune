import * as THREE from 'three';

export interface CloudMaterialOptions {
  readonly textureScale: number;
  readonly opacity: number;
  readonly tint: THREE.ColorRepresentation;
  readonly shellRadius: number;
  readonly parallaxStrength: number;
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
      uCameraCloudFixed: { value: new THREE.Vector3() },
      uShellRadius: { value: options.shellRadius },
      uParallaxStrength: { value: options.parallaxStrength },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vBodyDirection;
      varying vec3 vWorldDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyDirection = position;
        vWorldDirection = normalize(mat3(modelMatrix) * position);
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
      uniform vec3 uCameraCloudFixed;
      uniform float uShellRadius;
      uniform float uParallaxStrength;
      uniform float uTime;
      varying vec3 vBodyDirection;
      varying vec3 vWorldDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;

      vec2 cloudUv(vec3 direction) {
        float longitude = atan(direction.y, direction.x) / 6.283185307179586;
        float u = longitude < 0.0 ? longitude + 1.0 : longitude;
        float v = 0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793;
        return vec2(fract(u * uTextureScale), v);
      }

      vec2 sampleCloud(vec3 direction) {
        return texture2D(uCloudMap, cloudUv(normalize(direction))).rg;
      }

      void main() {
        // Varyings are interpolated across each triangle. Renormalizing here is
        // essential: using the interpolated chord directly reveals the sphere's
        // latitude/triangle structure in the equirectangular lookup.
        vec3 direction = normalize(vBodyDirection);
        vec3 toCamera = uCameraCloudFixed - direction * uShellRadius;
        float cameraDistance = length(toCamera);
        vec3 bodyView = cameraDistance > 0.001 ? toCamera / cameraDistance : direction;
        float radialView = abs(dot(direction, bodyView));
        vec3 tangentVector = bodyView - direction * dot(direction, bodyView);
        float tangentLength = length(tangentVector);
        vec3 viewTangent = tangentLength > 0.0001 ? tangentVector / tangentLength : vec3(0.0);
        float parallaxSpan = uParallaxStrength * (1.0 - radialView) / max(1.0, uTextureScale);

        // Four nearby samples provide a restrained sense of thickness at
        // grazing angles without introducing a volumetric render pass.
        vec2 field0 = sampleCloud(direction - viewTangent * parallaxSpan * 0.50);
        vec2 field1 = sampleCloud(direction - viewTangent * parallaxSpan * 0.17);
        vec2 field2 = sampleCloud(direction + viewTangent * parallaxSpan * 0.17);
        vec2 field3 = sampleCloud(direction + viewTangent * parallaxSpan * 0.50);
        vec2 field = (field0 + field1 + field2 + field3) * 0.25;
        float peakCoverage = max(max(field0.r, field1.r), max(field2.r, field3.r));
        float coverageSignal = field.r - (1.0 - field.g) * 0.07 + (peakCoverage - field.r) * 0.32;
        float coverage = smoothstep(0.08, 0.84, coverageSignal);
        float opticalDepth = clamp(field.g, 0.0, 1.0);

        vec3 sunDirection = normalize(uSunDirection);
        float sunFacing = max(0.0, dot(normalize(vWorldDirection), sunDirection));
        float daylight = 0.34 + 0.66 * sunFacing;
        float cameraOutside = step(uShellRadius, length(uCameraCloudFixed));
        float underside = mix(0.76, 1.0, cameraOutside);
        vec3 viewSunDirection = normalize(mat3(viewMatrix) * sunDirection);
        float forwardScatter = pow(max(0.0, dot(normalize(vViewDirection), -viewSunDirection)), 6.0);
        float rim = pow(1.0 - abs(dot(normalize(vViewNormal), normalize(vViewDirection))), 2.4);
        float softEdge = 4.0 * coverage * (1.0 - coverage);
        float silver = rim * softEdge * (0.18 + 0.82 * forwardScatter);
        vec3 color = uTint * (0.64 + daylight * 0.56) * underside;
        color *= 1.0 - opticalDepth * (1.0 - sunFacing) * 0.12;
        color += vec3(0.38, 0.42, 0.46) * silver;

        float alpha = coverage * mix(0.34, 1.0, opticalDepth) * uOpacity;
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
        vBodyDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D uCloudMap;
      uniform float uTextureScale;
      varying vec3 vBodyDirection;
      void main() {
        vec3 direction = normalize(vBodyDirection);
        float longitude = atan(direction.y, direction.x) / 6.283185307179586;
        float u = longitude < 0.0 ? longitude + 1.0 : longitude;
        float v = 0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793;
        vec2 field = texture2D(uCloudMap, vec2(fract(u * uTextureScale), v)).rg;
        if (field.r * field.g < 0.08) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }
    `,
    depthWrite: true,
    depthTest: true,
  });
}
