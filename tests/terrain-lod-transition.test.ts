import { describe, expect, it } from 'vitest';
import { TerrainLodTransitionManager } from '../src/render/terrain/lodTransition';

const rootChildren = ['0/1/0/0', '0/1/1/0', '0/1/0/1', '0/1/1/1'] as const;

function request(direction: 'split' | 'merge', ready = true) {
  return {
    parentKey: '0/0/0/0',
    childKeys: rootChildren,
    direction,
    sourceRenderable: ready,
    destinationRenderable: ready,
  } as const;
}

describe('terrain LOD transition state', () => {
  it('waits for both sets and does not count loading time', () => {
    const manager = new TerrainLodTransitionManager();
    expect(manager.request(request('split', false))).toBe('waiting');
    manager.advance(20, false, 1);
    expect(manager.snapshots()).toEqual([]);
    expect(manager.request(request('split'))).toBe('started');
    expect(manager.snapshots()[0]).toMatchObject({ progress: 0, direction: 'split' });
  });

  it('uses wall-clock normal and pressure durations', () => {
    const normal = new TerrainLodTransitionManager();
    normal.request(request('split'));
    expect(normal.advance(0.175, false, 1)[0].progress).toBeCloseTo(0.5, 12);
    expect(normal.advance(0.175, false, 2)[0]).toMatchObject({ progress: 1, state: 'release-pending' });

    const pressure = new TerrainLodTransitionManager();
    pressure.request(request('split'));
    expect(pressure.advance(0.1, true, 1)[0].progress).toBeCloseTo(0.5, 12);
    expect(pressure.advance(0.1, true, 2)[0].state).toBe('release-pending');

    const configured = new TerrainLodTransitionManager(1, 0.5);
    configured.request(request('split'));
    expect(configured.advance(0.25, false, 1)[0].progress).toBeCloseTo(0.25, 12);
    expect(configured.advance(0.125, true, 2)[0].progress).toBeCloseTo(0.5, 12);
  });

  it('reverses from current progress while retaining transition identity', () => {
    const manager = new TerrainLodTransitionManager();
    manager.request(request('split'));
    const halfway = manager.advance(0.175, false, 1)[0];
    expect(manager.request(request('merge'))).toBe('reversed');
    const reversed = manager.advance(0.0875, false, 2)[0];
    expect(reversed.id).toBe(halfway.id);
    expect(reversed.direction).toBe('merge');
    expect(reversed.progress).toBeCloseTo(0.25, 12);
  });

  it('retains the completed source for one submitted frame', () => {
    const manager = new TerrainLodTransitionManager();
    manager.request(request('split'));
    expect(manager.advance(0.35, false, 10)).toHaveLength(1);
    expect(manager.protectionKeys()).toEqual(new Set(['0/0/0/0', ...rootChildren]));
    expect(manager.advance(0, false, 10)).toHaveLength(1);
    expect(manager.advance(0, false, 11)).toEqual([]);
    expect(manager.protectionKeys().size).toBe(0);
  });

  it('serializes nested transitions on the same branch', () => {
    const manager = new TerrainLodTransitionManager();
    manager.request(request('split'));
    expect(manager.request({
      parentKey: '0/1/0/0',
      childKeys: ['0/2/0/0', '0/2/1/0', '0/2/0/1', '0/2/1/1'],
      direction: 'split',
      sourceRenderable: true,
      destinationRenderable: true,
    })).toBe('serialized');
  });

  it('rejects incomplete or unrelated child sets', () => {
    const manager = new TerrainLodTransitionManager();
    expect(() => manager.request({
      ...request('split'),
      childKeys: ['0/1/0/0', '0/1/0/0', '0/1/0/1', '0/1/1/1'],
    })).toThrow(/unique/i);
  });
});
