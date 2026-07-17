import * as THREE from 'three';
import type { EntryVisualDef } from '../content/bodyVisuals';
import type { Craft } from '../sim/vessel';
import type { QualityTier } from './bodyRenderer';
import { AirstreamDepthPass } from './airstreamDepth';
import { buildReentryGeometry, type ReentryGeometrySet } from './reentryGeometry';
import { ENTRY_THRESHOLDS, type ReentrySignal } from './reentrySignal';

export interface ReentryEffectUpdate {
  readonly velocityOS: THREE.Vector3;
  readonly flowAlign: number;
  readonly signal: ReentrySignal;
  readonly time: number;
  readonly wallDeltaSeconds: number;
  readonly reducedMotion?: boolean;
}

export interface ReentryEffectStats {
  readonly active: boolean;
  readonly strength: number;
  readonly transonic: number;
  readonly glow: boolean;
  readonly trails: boolean;
  readonly bowshock: boolean;
  readonly particles: number;
  readonly occlusion: boolean;
  readonly envelopeTriangles: number;
  readonly finSources: number;
  readonly geometryBytes: number;
}

type EffectMaterial = THREE.ShaderMaterial & { uniforms: Record<string, THREE.IUniform> };

const OCCLUSION_GLSL = `
  uniform sampler2D uOcclusionDepth;
  uniform vec2 uOcclusionTexel;
  uniform float uUseOcclusion;
  varying vec4 vOcclusionCoord;
  varying float vWindward;

  float reentryOcclusion() {
    if (uUseOcclusion < 0.5) return 1.0;
    vec3 projected = vOcclusionCoord.xyz / max(vOcclusionCoord.w, 0.00001);
    if (projected.x <= 0.0 || projected.x >= 1.0 || projected.y <= 0.0 || projected.y >= 1.0 || projected.z <= 0.0 || projected.z >= 1.0) return 1.0;
    // Conventional receiver-depth comparison. Normal-dependent bias prevents
    // the envelope from shadowing itself at grazing angles.
    float bias = mix(0.0045, 0.0012, clamp(vWindward, 0.0, 1.0));
    float receiver = projected.z - bias;
    float visible = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        float stored = texture2D(uOcclusionDepth, projected.xy + vec2(float(x), float(y)) * uOcclusionTexel).r;
        visible += receiver <= stored ? 1.0 : 0.0;
      }
    }
    return visible / 9.0;
  }
`;

function uniforms(palette: Readonly<EntryVisualDef>): Record<string, THREE.IUniform> {
  return {
    uVelocityOS: { value: new THREE.Vector3(0, 1, 0) },
    uOcclusionMatrix: { value: new THREE.Matrix4() },
    uOcclusionDepth: { value: null },
    uOcclusionTexel: { value: new THREE.Vector2(1, 1) },
    uUseOcclusion: { value: 0 },
    uStrength: { value: 0 },
    uTransonic: { value: 0 },
    uFlowAlign: { value: 1 },
    uTime: { value: 0 },
    uLength: { value: palette.lengthMultiplier },
    uOpacity: { value: palette.opacityMultiplier },
    uGlowMultiplier: { value: palette.glowMultiplier },
    uGlow: { value: new THREE.Color(palette.glow) },
    uGlowHot: { value: new THREE.Color(palette.glowHot) },
    uTrailPrimary: { value: new THREE.Color(palette.trailPrimary) },
    uTrailSecondary: { value: new THREE.Color(palette.trailSecondary) },
    uTrailTertiary: { value: new THREE.Color(palette.trailTertiary) },
    uStreak: { value: new THREE.Color(palette.streak) },
    uWrap: { value: new THREE.Color(palette.wrapLayer) },
    uShock: { value: new THREE.Color(palette.shockwave) },
  };
}

function materialBase(materialUniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string): EffectMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: materialUniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }) as EffectMaterial;
  // Additive sheets do not need Three's transparent double-sided two-pass
  // path. One pass avoids duplicate overdraw and keeps compileAsync bound to a
  // single current program per material.
  material.forceSinglePass = true;
  return material;
}

function envelopeVertex(bowl: boolean): string {
  return `
    #include <common>
    uniform vec3 uVelocityOS;
    uniform mat4 uOcclusionMatrix;
    uniform float uStrength;
    uniform float uFlowAlign;
    attribute float aExposure;
    attribute float aSeed;
    varying float vIntensity;
    varying float vWindward;
    varying float vSeed;
    varying vec4 vOcclusionCoord;
    #include <logdepthbuf_pars_vertex>
    void main() {
      vec3 n = normalize(normal);
      vWindward = max(0.0, dot(n, normalize(uVelocityOS)));
      float flowWeight = (1.0 + clamp(uFlowAlign, -1.0, 1.0)) * 0.5;
      float thermalExposure = 0.15 + 0.85 * (flowWeight * aExposure * aExposure + (1.0 - flowWeight) * (1.0 - aExposure) * (1.0 - aExposure));
      vIntensity = thermalExposure * (0.22 + 0.78 * vWindward);
      vSeed = aSeed;
      vec3 localPosition = position;
      ${bowl ? 'localPosition += normalize(uVelocityOS) * (0.12 + uStrength * 0.42) * (0.35 + vWindward * 0.65);' : ''}
      vOcclusionCoord = uOcclusionMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(localPosition, 1.0);
      #include <logdepthbuf_vertex>
    }
  `;
}

function glowFragment(bowl: boolean): string {
  return `
    #include <common>
    uniform float uStrength;
    uniform float uTransonic;
    uniform float uTime;
    uniform float uOpacity;
    uniform float uGlowMultiplier;
    uniform vec3 uGlow;
    uniform vec3 uGlowHot;
    uniform vec3 uShock;
    varying float vIntensity;
    varying float vSeed;
    ${OCCLUSION_GLSL}
    #include <logdepthbuf_pars_fragment>
    void main() {
      float occlusion = reentryOcclusion();
      float pulse = 0.91 + 0.09 * sin(uTime * 11.0 + vSeed * 31.0);
      float intensity = vIntensity * occlusion * pulse;
      ${bowl
        ? 'float alpha = uOpacity * smoothstep(0.25, 0.9, uStrength) * intensity * smoothstep(0.04, 0.62, vWindward) * 0.38; vec3 color = mix(uShock, uGlowHot, uStrength * 0.35);'
        : 'float alpha = uOpacity * uGlowMultiplier * (uStrength + uTransonic * 0.32) * intensity * 0.72; vec3 color = mix(uGlow, uGlowHot, clamp(uStrength * 1.25 + vWindward * 0.3, 0.0, 1.0)); color = mix(color, uShock, uTransonic * 0.86);'}
      if (alpha < 0.008) discard;
      float dither = fract(gl_FragCoord.x * 0.75487766 + gl_FragCoord.y * 0.56984029);
      alpha *= mix(0.94, 1.0, dither);
      gl_FragColor = vec4(color * alpha, alpha);
      #include <logdepthbuf_fragment>
    }
  `;
}

const FIN_VERTEX = `
  #include <common>
  uniform vec3 uVelocityOS;
  uniform mat4 uOcclusionMatrix;
  uniform float uStrength;
  uniform float uLength;
  uniform float uTime;
  attribute vec3 aCenter;
  attribute float aTrailT;
  attribute float aSide;
  attribute float aLayer;
  attribute float aExposure;
  attribute float aSeed;
  varying float vTrailT;
  varying float vLayer;
  varying float vSeed;
  varying float vWindward;
  varying vec4 vOcclusionCoord;
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec3 velocity = normalize(uVelocityOS);
    vec3 n = normalize(normal);
    vWindward = max(0.0, dot(n, velocity));
    float eligible = smoothstep(0.04, 0.42, vWindward) * smoothstep(0.08, 0.28, uStrength);
    float layerScale = mix(0.72, 1.18, aLayer);
    vec3 base = aCenter + (position - aCenter) * layerScale;
    float noise = 0.78 + 0.28 * sin(aSeed * 47.0 + uTime * 3.7 + aTrailT * 8.0);
    vec3 p = base - velocity * aTrailT * uLength * (1.4 + uStrength * 5.8) * noise;
    p += n * sin(aTrailT * 3.14159) * (0.04 + 0.12 * aLayer) * uStrength;
    p = mix(aCenter, p, eligible);
    vTrailT = aTrailT;
    vLayer = aLayer;
    vSeed = aSeed;
    vOcclusionCoord = uOcclusionMatrix * vec4(aCenter, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FIN_FRAGMENT = `
  #include <common>
  uniform float uStrength;
  uniform float uOpacity;
  uniform vec3 uTrailPrimary;
  uniform vec3 uTrailSecondary;
  uniform vec3 uTrailTertiary;
  uniform vec3 uWrap;
  varying float vTrailT;
  varying float vLayer;
  varying float vSeed;
  ${OCCLUSION_GLSL}
  #include <logdepthbuf_pars_fragment>
  void main() {
    float occlusion = reentryOcclusion();
    float fade = pow(max(0.0, 1.0 - vTrailT), mix(1.1, 0.72, vLayer));
    float broken = step(0.16 + vSeed * 0.2, fade);
    vec3 core = mix(uTrailPrimary, uTrailSecondary, smoothstep(0.2, 0.72, vTrailT));
    core = mix(core, uTrailTertiary, smoothstep(0.68, 1.0, vTrailT));
    vec3 color = mix(core, uWrap, vLayer * 0.72);
    float alpha = fade * broken * occlusion * uStrength * uOpacity * mix(0.56, 0.22, vLayer);
    if (alpha < 0.006) discard;
    gl_FragColor = vec4(color * alpha, alpha);
    #include <logdepthbuf_fragment>
  }
`;

const WISP_VERTEX = `
  #include <common>
  uniform vec3 uVelocityOS;
  uniform mat4 uOcclusionMatrix;
  uniform float uStrength;
  uniform float uTime;
  attribute vec3 aCenter;
  attribute float aTrailT;
  attribute float aLayer;
  attribute float aSeed;
  varying float vTrailT;
  varying float vLayer;
  varying float vSeed;
  varying float vWindward;
  varying vec4 vOcclusionCoord;
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec3 velocity = normalize(uVelocityOS);
    vec3 n = normalize(normal);
    float facing = dot(n, velocity);
    float rim = 1.0 - smoothstep(0.08, 0.48, abs(facing));
    vec3 p = aCenter + (position - aCenter) * (1.0 + aLayer * 0.32);
    p += velocity * (0.1 + uStrength * 0.34) * (1.0 - aTrailT * 0.45);
    p += n * aTrailT * (0.18 + uStrength * 0.5) * (0.8 + 0.2 * sin(uTime * 5.0 + aSeed * 29.0));
    p = mix(aCenter, p, rim * smoothstep(0.28, 0.5, uStrength));
    vTrailT = aTrailT;
    vLayer = aLayer;
    vSeed = aSeed;
    vWindward = max(0.0, facing);
    vOcclusionCoord = uOcclusionMatrix * vec4(aCenter, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const WISP_FRAGMENT = `
  #include <common>
  uniform float uStrength;
  uniform float uOpacity;
  uniform vec3 uShock;
  uniform vec3 uGlowHot;
  varying float vTrailT;
  varying float vLayer;
  varying float vSeed;
  ${OCCLUSION_GLSL}
  #include <logdepthbuf_pars_fragment>
  void main() {
    float alpha = (1.0 - vTrailT) * reentryOcclusion() * uStrength * uOpacity * mix(0.32, 0.16, vLayer);
    if (alpha < 0.008) discard;
    vec3 color = mix(uShock, uGlowHot, vTrailT * 0.55);
    gl_FragColor = vec4(color * alpha, alpha);
    #include <logdepthbuf_fragment>
  }
`;

class ReentrySparks {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly positionAttribute: THREE.BufferAttribute;
  private cursor = 0;
  private seed = 0x4f1bbcdc;
  private activeCount = 0;

  constructor(private readonly capacity: number, color: string) {
    this.positions = new Float32Array(capacity * 3);
    this.positions.fill(1_000_000);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setDrawRange(0, capacity);
    const material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: `
        #include <common>
        varying float vDepthFade;
        #include <logdepthbuf_pars_vertex>
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(34.0 / max(1.0, -mv.z), 1.2, 5.0);
          vDepthFade = clamp(12.0 / max(1.0, -mv.z), 0.25, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        uniform vec3 uColor;
        varying float vDepthFade;
        #include <logdepthbuf_pars_fragment>
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float alpha = max(0.0, 1.0 - dot(q, q)) * vDepthFade;
          if (alpha < 0.05) discard;
          gl_FragColor = vec4(uColor * alpha, alpha);
          #include <logdepthbuf_fragment>
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 53;
  }

  private random(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 0x1_0000_0000;
  }

  update(
    delta: number,
    strength: number,
    threshold: number,
    velocityOS: THREE.Vector3,
    radius: number,
    enabled = true,
  ): void {
    if (!enabled) {
      this.life.fill(0);
      this.activeCount = 0;
      this.points.visible = false;
      return;
    }
    const dt = Math.max(0, Math.min(0.1, delta));
    this.activeCount = 0;
    for (let index = 0; index < this.capacity; index++) {
      if (this.life[index] <= 0) continue;
      this.life[index] -= dt;
      const base = index * 3;
      if (this.life[index] <= 0) {
        this.positions[base] = 1_000_000;
        this.positions[base + 1] = 1_000_000;
        this.positions[base + 2] = 1_000_000;
        continue;
      }
      this.positions[base] += this.velocities[base] * dt;
      this.positions[base + 1] += this.velocities[base + 1] * dt;
      this.positions[base + 2] += this.velocities[base + 2] * dt;
      this.activeCount++;
    }
    if (strength > threshold) {
      const spawn = Math.min(8, Math.ceil((strength - threshold) * 18));
      const direction = velocityOS.clone().normalize();
      for (let count = 0; count < spawn; count++) {
        const index = this.cursor++ % this.capacity;
        const base = index * 3;
        const wasActive = this.life[index] > 0;
        const theta = this.random() * Math.PI * 2;
        const reference = Math.abs(direction.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const tangent = new THREE.Vector3().crossVectors(direction, reference).normalize();
        const bitangent = new THREE.Vector3().crossVectors(direction, tangent).normalize();
        const radial = tangent.multiplyScalar(Math.cos(theta)).addScaledVector(bitangent, Math.sin(theta))
          .multiplyScalar(radius * (0.25 + this.random() * 0.45));
        const origin = direction.clone().multiplyScalar(radius * 0.55).add(radial);
        const trail = direction.clone().multiplyScalar(-(2 + this.random() * 6));
        trail.add(radial.normalize().multiplyScalar((this.random() - 0.5) * 2.5));
        this.positions[base] = origin.x;
        this.positions[base + 1] = origin.y;
        this.positions[base + 2] = origin.z;
        this.velocities[base] = trail.x;
        this.velocities[base + 1] = trail.y;
        this.velocities[base + 2] = trail.z;
        this.life[index] = 0.25 + this.random() * 0.65;
        if (!wasActive) this.activeCount++;
      }
    }
    this.positionAttribute.needsUpdate = true;
    this.points.visible = this.activeCount > 0 || strength > threshold;
  }

  count(): number { return this.activeCount; }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

export class ActiveReentryEffect {
  readonly group = new THREE.Group();
  readonly geometry: ReentryGeometrySet;
  private readonly materials: EffectMaterial[];
  private readonly glow: THREE.Mesh;
  private readonly trails: THREE.Mesh;
  private readonly bowl: THREE.Mesh;
  private readonly wisps: THREE.Mesh;
  private readonly sparks: ReentrySparks;
  private readonly depthPass: AirstreamDepthPass | null;
  private lastStats: ReentryEffectStats;

  constructor(
    craft: Craft,
    axialFrac: ReadonlyMap<number, number>,
    quality: QualityTier,
    private readonly palette: Readonly<EntryVisualDef>,
  ) {
    this.geometry = buildReentryGeometry(craft, axialFrac, quality);
    const glowMaterial = materialBase(uniforms(palette), envelopeVertex(false), glowFragment(false));
    const trailMaterial = materialBase(uniforms(palette), FIN_VERTEX, FIN_FRAGMENT);
    const bowlMaterial = materialBase(uniforms(palette), envelopeVertex(true), glowFragment(true));
    const wispMaterial = materialBase(uniforms(palette), WISP_VERTEX, WISP_FRAGMENT);
    this.materials = [glowMaterial, trailMaterial, bowlMaterial, wispMaterial];
    this.glow = new THREE.Mesh(this.geometry.envelope, glowMaterial);
    this.trails = new THREE.Mesh(this.geometry.fins, trailMaterial);
    this.bowl = new THREE.Mesh(this.geometry.envelope, bowlMaterial);
    this.wisps = new THREE.Mesh(this.geometry.fins, wispMaterial);
    this.glow.name = 'reentry-glow';
    this.trails.name = 'reentry-trails';
    this.bowl.name = 'reentry-bowshock-bowl';
    this.wisps.name = 'reentry-bowshock-wisps';
    this.glow.visible = false;
    this.trails.visible = false;
    this.bowl.visible = false;
    this.wisps.visible = false;
    this.glow.renderOrder = 50;
    this.trails.renderOrder = 51;
    this.bowl.renderOrder = 52;
    this.wisps.renderOrder = 52;
    for (const mesh of [this.glow, this.trails, this.bowl, this.wisps]) mesh.frustumCulled = false;
    const particleBudget = quality === 'low' ? 96 : quality === 'medium' ? 224 : 420;
    this.sparks = new ReentrySparks(particleBudget, palette.streak);
    this.sparks.points.visible = false;
    this.group.name = 'reentry-effect-active-vessel';
    this.group.add(this.glow, this.trails, this.bowl, this.wisps, this.sparks.points);
    this.group.visible = false;
    const depthSize = quality === 'high' ? 512 : 384;
    this.depthPass = quality === 'low' ? null : new AirstreamDepthPass(this.geometry.envelope, depthSize);
    this.lastStats = this.makeStats({ strength: 0, transonic: 0 });
  }

  update(input: Readonly<ReentryEffectUpdate>): void {
    for (const material of this.materials) {
      material.uniforms.uVelocityOS.value.copy(input.velocityOS);
      material.uniforms.uStrength.value = input.signal.strength;
      material.uniforms.uTransonic.value = input.signal.transonic;
      material.uniforms.uFlowAlign.value = input.flowAlign;
      material.uniforms.uTime.value = input.reducedMotion ? 0 : input.time;
    }
    this.glow.visible = input.signal.strength > ENTRY_THRESHOLDS.glow || input.signal.transonic > 0.02;
    this.trails.visible = input.signal.strength > ENTRY_THRESHOLDS.trails;
    this.bowl.visible = input.signal.strength > ENTRY_THRESHOLDS.bowshock;
    this.wisps.visible = input.signal.strength > ENTRY_THRESHOLDS.bowshock;
    const radius = this.geometry.envelope.boundingSphere?.radius ?? 1;
    this.sparks.update(
      input.wallDeltaSeconds,
      input.signal.strength,
      this.palette.particleThreshold,
      input.velocityOS,
      radius,
      !input.reducedMotion,
    );
    this.group.visible = this.glow.visible || this.trails.visible || this.bowl.visible || this.sparks.points.visible;
    this.lastStats = this.makeStats(input.signal);
  }

  prepareOcclusion(renderer: THREE.WebGLRenderer, velocityOS: THREE.Vector3): void {
    if (!this.depthPass || !this.group.visible) {
      for (const material of this.materials) material.uniforms.uUseOcclusion.value = 0;
      this.lastStats = this.makeStats({ strength: this.lastStats.strength, transonic: this.lastStats.transonic });
      return;
    }
    this.depthPass.update(velocityOS);
    this.depthPass.render(renderer);
    for (const material of this.materials) {
      material.uniforms.uOcclusionMatrix.value.copy(this.depthPass.matrix);
      material.uniforms.uOcclusionDepth.value = this.depthPass.target.depthTexture;
      material.uniforms.uOcclusionTexel.value.copy(this.depthPass.texelSize);
      material.uniforms.uUseOcclusion.value = 1;
    }
    this.lastStats = this.makeStats({ strength: this.lastStats.strength, transonic: this.lastStats.transonic });
  }

  debugOcclusionPixel(renderer: THREE.WebGLRenderer, x: number, y: number): Uint8Array | null {
    return this.depthPass?.readDebugPixel(renderer, x, y) ?? null;
  }

  stats(): Readonly<ReentryEffectStats> { return this.lastStats; }

  /** Detached clone used only by isolated shader compilation. Resources stay owned here. */
  compileCandidateRoot(): THREE.Group {
    const root = this.group.clone(true);
    if (this.depthPass) root.add(this.depthPass.compileCandidateObject());
    root.visible = true;
    root.traverse((object) => { object.visible = true; });
    return root;
  }

  private makeStats(signal: ReentrySignal): ReentryEffectStats {
    return Object.freeze({
      active: this.group.visible,
      strength: signal.strength,
      transonic: signal.transonic,
      glow: this.glow.visible,
      trails: this.trails.visible,
      bowshock: this.bowl.visible || this.wisps.visible,
      particles: this.sparks.count(),
      occlusion: this.depthPass !== null && this.materials[0]?.uniforms.uUseOcclusion.value === 1,
      envelopeTriangles: this.geometry.envelopeTriangles,
      finSources: this.geometry.finSources,
      geometryBytes: this.geometry.bytes,
    });
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.envelope.dispose();
    this.geometry.fins.dispose();
    for (const material of this.materials) material.dispose();
    this.sparks.dispose();
    this.depthPass?.dispose();
    this.group.clear();
  }
}
