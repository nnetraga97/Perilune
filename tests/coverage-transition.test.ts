import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { CoverageTransition } from '../src/render/coverageTransition';
import { PlanetRenderer } from '../src/render/planet';

describe('coverage-safe compact-to-terrain transition', () => {
  it('does not count load time and starts only after complete coverage is observed', () => {
    const transition = new CoverageTransition();
    transition.requestTerrain();
    expect(transition.update(20, false, false)).toMatchObject({ state: 'prewarming', progress: 0 });
    expect(transition.update(20, true, false)).toMatchObject({ state: 'fading', progress: 0 });
    const halfway = transition.update(0.175, true, false);
    expect(halfway.progress).toBeCloseTo(0.5, 12);
    expect(halfway.compactCoverage + halfway.terrainCoverage).toBeCloseTo(1, 12);
  });

  it('is frame-rate independent at the normal and pressure-shortened bounds', () => {
    const run = (steps: number[], pressure: boolean) => {
      const transition = new CoverageTransition();
      transition.requestTerrain();
      transition.update(0, true, pressure);
      let snapshot = transition.snapshot();
      for (const delta of steps) snapshot = transition.update(delta, true, pressure);
      return snapshot;
    };
    expect(run([0.1, 0.1, 0.1, 0.05], false).state).toBe('terrain');
    expect(run([0.01, 0.04, 0.08, 0.07], true).state).toBe('terrain');
    expect(run([0.1, 0.1, 0.149], false).state).toBe('fading');
    expect(run([0.1, 0.099], true).state).toBe('fading');
  });

  it('never exceeds the hard maximum and does not roll back committed terrain for streaming churn', () => {
    const transition = new CoverageTransition({ normalDurationSeconds: 10, pressureDurationSeconds: 5 });
    transition.requestTerrain();
    transition.update(0, true, false);
    expect(transition.update(1.49, true, false).state).toBe('fading');
    expect(transition.update(0.01, true, false).state).toBe('terrain');
    expect(transition.update(0, false, false)).toEqual({
      state: 'terrain', compactCoverage: 0, terrainCoverage: 1, progress: 1,
    });
  });

  it('does not declare terrain ready while any visible coverage gap remains', () => {
    const renderer = new PlanetRenderer(new GameState().universe.get('veyra'));
    expect(renderer.coverageReady()).toBe(false);
    for (let frame = 0; frame < 4; frame++) {
      renderer.update(
        { x: renderer.body.radius * 2, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0, z: 0 },
      );
    }
    expect(renderer.coverageReady()).toBe(true);
    renderer.dispose();
  });
});
