import { describe, expect, test } from 'vitest';
import { addPart, createCraft } from '../src/sim/vessel';
import {
  expandedBranchKeys,
  normalizedBranchRoots,
  surfaceSymmetryPlacements,
} from '../src/ui/editor';

function branchedCraft() {
  const craft = createCraft('Selection graph');
  const root = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 4, z: 0 });
  const tank = addPart(craft, 'tank-s2', root.key, 'stack-bottom', { x: 0, y: 2, z: 0 });
  const left = addPart(craft, 'dec-radial', tank.key, 'surface', { x: -1, y: 2, z: 0 });
  const leftBooster = addPart(craft, 'srb-torch', left.key, 'surface', { x: -2, y: 2, z: 0 });
  const right = addPart(craft, 'dec-radial', tank.key, 'surface', { x: 1, y: 2, z: 0 });
  const rightBooster = addPart(craft, 'srb-torch', right.key, 'surface', { x: 2, y: 2, z: 0 });
  return { craft, root, tank, left, leftBooster, right, rightBooster };
}

describe('VAB branch selection', () => {
  test('normalizes an ancestor and descendant to one movable root', () => {
    const { craft, left, leftBooster, right } = branchedCraft();

    expect(normalizedBranchRoots(craft, [left.key, leftBooster.key, right.key])).toEqual([
      left.key,
      right.key,
    ]);
  });

  test('expands independent roots without translating overlapping descendants twice', () => {
    const { craft, left, leftBooster, right, rightBooster, tank } = branchedCraft();
    const roots = normalizedBranchRoots(craft, [left.key, leftBooster.key, right.key]);
    const expanded = expandedBranchKeys(craft, roots);

    expect(expanded).toEqual(new Set([left.key, right.key, leftBooster.key, rightBooster.key]));
    expect(expanded.has(tank.key)).toBe(false);
  });
});

describe('VAB surface symmetry placement', () => {
  test('propagates children across matching radial decoupler parents', () => {
    const craft = createCraft('Radial parent symmetry');
    const tank = addPart(craft, 'tank-s2', null, 'root', { x: 0, y: 2, z: 0 });
    const group = 42;
    const right = addPart(craft, 'dec-radial', tank.key, 'surface', { x: 1, y: 2, z: 0 }, undefined, group);
    const left = addPart(craft, 'dec-radial', tank.key, 'surface', { x: -1, y: 2, z: 0 }, undefined, group);

    const placements = surfaceSymmetryPlacements(
      craft,
      right.key,
      { x: 2, y: 2, z: 0 },
      2,
      'radial',
    );

    expect(placements.map((placement) => placement.parentKey)).toEqual([right.key, left.key]);
    expect(placements[0].position).toMatchObject({ x: 2, y: 2, z: 0 });
    expect(placements[1].position.x).toBeCloseTo(-2);
    expect(placements[1].position.y).toBeCloseTo(2);
    expect(placements[1].position.z).toBeCloseTo(0);
  });

  test('retains ordinary radial placement when the parent is not symmetric', () => {
    const craft = createCraft('Direct radial symmetry');
    const tank = addPart(craft, 'tank-s2', null, 'root', { x: 0, y: 2, z: 0 });

    const placements = surfaceSymmetryPlacements(
      craft,
      tank.key,
      { x: 1, y: 2, z: 0 },
      2,
      'radial',
    );

    expect(placements.map((placement) => placement.parentKey)).toEqual([tank.key, tank.key]);
    expect(placements[0].position.x).toBeCloseTo(1);
    expect(placements[1].position.x).toBeCloseTo(-1);
  });
});
