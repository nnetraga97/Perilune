import { describe, expect, it } from 'vitest';
import type { OrbitalElements } from '../src/core/orbit';
import { ManeuverPlanController } from '../src/sim/maneuverPlan';
import { pickOrbitSegment } from '../src/ui/orbitPicking';
import { maneuverLeadArcEnd } from '../src/ui/mapView';

const circularOrbit = (): OrbitalElements => ({
  a: 720_000,
  e: 0,
  i: 0,
  raan: 0,
  argPe: 0,
  meanAnomaly0: 0,
  epoch: 100,
  mu: 3.5316e12,
});

describe('map maneuver plan authority', () => {
  it('draws at most one parking-orbit revolution before a distant transfer node', () => {
    const orbit = circularOrbit();
    const period = Math.PI * 2 * Math.sqrt((orbit.a ** 3) / orbit.mu);

    expect(maneuverLeadArcEnd(orbit, 100, 100 + period * 400)).toBeCloseTo(100 + period, 9);
    expect(maneuverLeadArcEnd(orbit, 100, 100 + period * 0.25)).toBeCloseTo(100 + period * 0.25, 9);
  });

  it('does not truncate an open pre-node conic as if it were periodic', () => {
    const hyperbolic = { ...circularOrbit(), a: -720_000, e: 1.4 };
    expect(maneuverLeadArcEnd(hyperbolic, 100, 25_000)).toBe(25_000);
  });

  it('keeps the planned target tied to its captured reference orbit', () => {
    const controller = new ManeuverPlanController();
    const liveOrbit = circularOrbit();
    const plan = controller.create('vessel-1', 'veyra', liveOrbit, {
      time: 240,
      prograde: 65,
      normal: 0,
      radial: 0,
    });
    const targetA = { ...plan.targetOrbit };

    liveOrbit.a = 900_000;
    liveOrbit.meanAnomaly0 = 1.4;

    expect(controller.current?.referenceOrbit.a).toBe(720_000);
    expect(controller.current?.targetOrbit).toEqual(targetA);
  });

  it('only counts thrust delivered along the planned burn vector', () => {
    const controller = new ManeuverPlanController();
    const plan = controller.create('vessel-1', 'veyra', circularOrbit(), {
      time: 240,
      prograde: 100,
      normal: 0,
      radial: 0,
    });
    controller.beginExecution();
    const wrongWay = plan.burnDirection.clone().negate();

    controller.consumeDeliveredDeltaV(10, wrongWay, 2);
    expect(controller.current?.remainingDeltaV).toBeCloseTo(100, 6);

    controller.consumeDeliveredDeltaV(10, plan.burnDirection, 2);
    expect(controller.current?.remainingDeltaV).toBeCloseTo(80, 6);
  });

  it('locks edits after execution begins', () => {
    const controller = new ManeuverPlanController();
    controller.create('vessel-1', 'veyra', circularOrbit(), {
      time: 240,
      prograde: 25,
      normal: 0,
      radial: 0,
    });
    controller.beginExecution();
    controller.update({ time: 300, prograde: 80, normal: 10, radial: 5 });

    expect(controller.current?.node).toEqual({ time: 240, prograde: 25, normal: 0, radial: 0 });
  });

  it('queues, selects, and chains multiple maneuver nodes', () => {
    const controller = new ManeuverPlanController();
    const first = controller.create('vessel-1', 'veyra', circularOrbit(), {
      time: 240,
      prograde: 25,
      normal: 0,
      radial: 0,
    });
    const second = controller.create('vessel-1', 'veyra', circularOrbit(), {
      time: 480,
      prograde: 15,
      normal: 2,
      radial: 0,
    });

    expect(controller.scheduledFor('vessel-1', 'veyra').map((plan) => plan.id)).toEqual([first.id, second.id]);
    expect(second.referenceOrbit).toEqual(first.targetOrbit);
    controller.select(first.id);
    expect(controller.current?.id).toBe(first.id);
    controller.clear(first.id);
    expect(controller.current?.id).toBe(second.id);
  });
});

describe('screen-space orbit picking', () => {
  it('accepts clicks inside the interaction band even when they miss the drawn line', () => {
    const points = [
      { x: 20, y: 50, depth: 0.3, visible: true },
      { x: 120, y: 50, depth: 0.4, visible: true },
      { x: 180, y: 90, depth: 0.5, visible: true },
    ];

    const pick = pickOrbitSegment(points, 70, 60, 12);
    expect(pick).not.toBeNull();
    expect(pick?.segmentIndex).toBe(0);
    expect(pick?.fraction).toBeCloseTo(0.25, 4);
    expect(pickOrbitSegment(points, 70, 65, 12)).toBeNull();
  });

  it('prefers the nearer-depth segment when projected paths overlap', () => {
    const points = [
      { x: 10, y: 10, depth: 0.8, visible: true },
      { x: 90, y: 90, depth: 0.8, visible: true },
      { x: 10, y: 90, depth: 0.2, visible: true },
      { x: 90, y: 10, depth: 0.2, visible: true },
    ];

    const pick = pickOrbitSegment(points, 50, 50, 4);
    expect(pick?.segmentIndex).toBe(2);
  });

  it('ignores segments clipped out of the camera view', () => {
    const pick = pickOrbitSegment([
      { x: 10, y: 10, depth: 0.2, visible: false },
      { x: 90, y: 10, depth: 0.2, visible: true },
    ], 50, 10, 24);

    expect(pick).toBeNull();
  });
});
