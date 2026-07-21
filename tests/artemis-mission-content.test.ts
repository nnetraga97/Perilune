import { describe, expect, it } from 'vitest';
import {
  ARTEMIS_IV_MISSION,
  ARTEMIS_IV_TIMELINE,
} from '../src/content/missions/artemisIV';
import { MissionPlaybackState } from '../src/mission/playbackState';

function relativePosition(
  entity: { readonly position: { readonly x: number; readonly y: number; readonly z: number } },
  target: { readonly position: { readonly x: number; readonly y: number; readonly z: number } },
): readonly [number, number, number] {
  return [
    entity.position.x - target.position.x,
    entity.position.y - target.position.y,
    entity.position.z - target.position.z,
  ];
}

function distance(left: readonly number[], right: readonly number[]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function attitudeArc(
  left: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  right: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
): number {
  const dot = Math.abs(left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w);
  return 2 * Math.acos(Math.min(1, dot));
}

describe('Artemis IV mission content', () => {
  it('keeps Orion and I-Hab world poses continuous across hard docking', () => {
    const playback = new MissionPlaybackState(ARTEMIS_IV_MISSION);
    const before = playback.evaluate(ARTEMIS_IV_TIMELINE.hardDock - 0.001);
    const docked = playback.evaluate(ARTEMIS_IV_TIMELINE.hardDock);

    for (const id of ['orion', 'i-hab'] as const) {
      const beforeRelative = relativePosition(before.entitiesById[id], before.entitiesById.gateway);
      const dockedRelative = relativePosition(docked.entitiesById[id], docked.entitiesById.gateway);
      expect(distance(beforeRelative, dockedRelative)).toBeLessThan(0.001);
      expect(attitudeArc(before.entitiesById[id].attitude, docked.entitiesById[id].attitude)).toBeLessThan(0.0001);
      expect(before.entitiesById[id].attachedToEntityId).toBeNull();
      expect(docked.entitiesById[id].attachedToEntityId).toBe('gateway');
    }

    expect(Math.abs(
      before.telemetryById['range-to-gateway'].value
        - docked.telemetryById['range-to-gateway'].value,
    )).toBeLessThan(0.001);
    expect(distance(
      relativePosition(docked.entitiesById.orion, docked.entitiesById.gateway),
      relativePosition(docked.entitiesById['i-hab'], docked.entitiesById.gateway),
    )).toBeCloseTo(9, 3);
  });
});
