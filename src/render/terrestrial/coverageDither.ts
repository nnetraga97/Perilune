import * as THREE from 'three';

export type CoverageDitherRole = 'compact' | 'terrain';

export interface CoverageDitherBinding {
  readonly progress: { value: number };
  setProgress(value: number): void;
}

/** Install complementary screen-space discard patterns on an existing material. */
export function installCoverageDither(
  material: THREE.Material,
  role: CoverageDitherRole,
): CoverageDitherBinding {
  const progress = { value: role === 'compact' ? 0 : 0 };
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    shader.uniforms.uCoverageProgress = progress;
    const predicate = role === 'compact'
      ? 'if (coverageNoise < uCoverageProgress) discard;'
      : 'if (coverageNoise >= uCoverageProgress) discard;';
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
float coverageNoise = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
${predicate}`,
    );
  };
  material.customProgramCacheKey = () => `${previousKey()}:coverage-dither:${role}`;
  material.needsUpdate = true;
  return Object.freeze({
    progress,
    setProgress(value: number) {
      progress.value = Math.max(0, Math.min(1, value));
    },
  });
}
