import * as THREE from 'three';

export interface CloudMaterialOptions {
  readonly textureScale: number;
  readonly opacity: number;
  readonly tint: THREE.ColorRepresentation;
  readonly shellRadius: number;
  readonly parallaxStrength: number;
  readonly volume?: {
    readonly baseRadius: number;
    readonly topRadius: number;
    readonly samples: number;
    readonly noiseOctaves: 2 | 3;
  };
}

export function createCloudMaterial(
  cloudTexture: THREE.Texture,
  options: Readonly<CloudMaterialOptions>,
): THREE.ShaderMaterial {
  cloudTexture.colorSpace = THREE.NoColorSpace;
  cloudTexture.wrapS = THREE.RepeatWrapping;
  cloudTexture.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.ShaderMaterial({
    defines: {
      CLOUD_VOLUMETRIC: options.volume ? 1 : 0,
      CLOUD_VIEW_SAMPLES: options.volume?.samples ?? 1,
      CLOUD_NOISE_OCTAVES: options.volume?.noiseOctaves ?? 2,
    },
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
      uVolumeBaseRadius: { value: options.volume?.baseRadius ?? options.shellRadius },
      uVolumeTopRadius: { value: options.volume?.topRadius ?? options.shellRadius },
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
      uniform float uVolumeBaseRadius;
      uniform float uVolumeTopRadius;
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

      float cloudNoise(vec3 p) {
        float first = sin(p.x + sin(p.z * 0.73) + p.y * 0.37);
        float second = sin(p.y * 1.27 + sin(p.x * 0.83) - p.z * 0.41);
        return clamp(0.5 + first * 0.27 + second * 0.23, 0.0, 1.0);
      }

      float cloudFbm(vec3 p) {
        float value = cloudNoise(p) * 0.64;
        value += cloudNoise(p * 2.03 + 11.7) * 0.36;
#if CLOUD_NOISE_OCTAVES >= 3
        value *= 0.86;
        value += cloudNoise(p * 4.07 - 7.1) * 0.14;
#endif
        return value;
      }

      vec2 cloudRaySphere(vec3 origin, vec3 direction, float radius) {
        float b = dot(origin, direction);
        float c = dot(origin, origin) - radius * radius;
        float discriminant = b * b - c;
        if (discriminant < 0.0) return vec2(1.0, -1.0);
        float root = sqrt(discriminant);
        return vec2(-b - root, -b + root);
      }

      void main() {
        // Varyings are interpolated across each triangle. Renormalizing here is
        // essential: using the interpolated chord directly reveals the sphere's
        // latitude/triangle structure in the equirectangular lookup.
        vec3 direction = normalize(vBodyDirection);
#if CLOUD_VOLUMETRIC == 1
        vec3 shellPoint = direction * uVolumeTopRadius;
        vec3 rayDirection = normalize(shellPoint - uCameraCloudFixed);
        vec2 outerHit = cloudRaySphere(uCameraCloudFixed, rayDirection, uVolumeTopRadius);
        float rayStart = max(0.0, outerHit.x);
        float rayEnd = outerHit.y;
        vec2 baseHit = cloudRaySphere(uCameraCloudFixed, rayDirection, uVolumeBaseRadius);
        if (baseHit.x > rayStart && baseHit.x < rayEnd) rayEnd = baseHit.x;
        if (rayEnd <= rayStart) discard;
        float stepLength = (rayEnd - rayStart) / float(CLOUD_VIEW_SAMPLES);
        float layerDepth = max(1.0, uVolumeTopRadius - uVolumeBaseRadius);
        float viewTransmittance = 1.0;
        vec3 accumulated = vec3(0.0);
        vec3 sunDirection = normalize(uSunDirection);
        float viewSunCosine = dot(rayDirection, sunDirection);
        float forwardScatter = pow(max(0.0, viewSunCosine), 8.0);
        for (int sampleIndex = 0; sampleIndex < CLOUD_VIEW_SAMPLES; sampleIndex++) {
          float distance = rayStart + (float(sampleIndex) + 0.5) * stepLength;
          vec3 samplePosition = uCameraCloudFixed + rayDirection * distance;
          float sampleRadius = length(samplePosition);
          float heightFraction = (sampleRadius - uVolumeBaseRadius) / layerDepth;
          if (heightFraction > 0.0 && heightFraction < 1.0) {
            vec3 sampleDirection = samplePosition / sampleRadius;
            vec2 authored = sampleCloud(sampleDirection);
            float macroCoverage = smoothstep(0.08, 0.82, authored.r - (1.0 - authored.g) * 0.06);
            vec3 noisePosition = sampleDirection * 22.0 + vec3(0.0, uTime * 0.00007, heightFraction * 3.1);
            float erosion = cloudFbm(noisePosition);
            float threshold = mix(0.72, 0.30, macroCoverage);
            float heightShape = smoothstep(0.0, 0.16, heightFraction) *
              (1.0 - smoothstep(0.68, 1.0, heightFraction));
            float density = smoothstep(threshold, threshold + 0.16, erosion) *
              macroCoverage * heightShape * mix(0.55, 1.0, authored.g);
            float opticalStep = density * stepLength / layerDepth * 5.2;
            float segmentAlpha = 1.0 - exp(-opticalStep);
            float sunFacing = max(0.0, dot(sampleDirection, sunDirection));
            vec3 cloudColor = uTint * mix(0.34, 1.08, sunFacing);
            cloudColor += vec3(0.52, 0.58, 0.64) * forwardScatter * (1.0 - viewTransmittance);
            accumulated += viewTransmittance * cloudColor * segmentAlpha;
            viewTransmittance *= 1.0 - segmentAlpha;
          }
        }
        float alpha = (1.0 - viewTransmittance) * uOpacity;
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(accumulated * uOpacity, alpha);
#else
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
#endif
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    premultipliedAlpha: options.volume !== undefined,
  });
  material.userData.cloudModel = options.volume ? 'bounded-volume' : 'parallax-shell';
  return material;
}
