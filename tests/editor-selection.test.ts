import { describe, expect, test } from 'vitest';
import { addPart, createCraft } from '../src/sim/vessel';
import { expandedBranchKeys, normalizedBranchRoots } from '../src/ui/editor';

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
