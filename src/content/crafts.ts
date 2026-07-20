import { addPart, createCraft, type Craft } from '../sim/vessel';

export interface BuiltInCraftDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  create(): Craft;
}

const identity = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function yaw(angle: number) {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}

/** The authored all-parts demonstration vehicle shown in the Blender handoff. */
export function createWayfarerDemonstrator(): Craft {
  const craft = createCraft('Wayfarer Heavy Demonstrator');

  // Controlled upper stage, built downward so the interstage keeps the pod side.
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 8.235, z: 0 }, identity);
  const podTank = addPart(craft, 'tank-s2', pod.key, 'stack-bottom', { x: 0, y: 6.91, z: 0 }, identity);
  const colt = addPart(craft, 'eng-colt', podTank.key, 'stack-bottom', { x: 0, y: 5.785, z: 0 }, identity);
  const interstage = addPart(craft, 'dec-interstage-ms', colt.key, 'stack-bottom', { x: 0, y: 5.48, z: 0 }, identity);

  const upperMuleTank = addPart(craft, 'tank-m4', interstage.key, 'stack-bottom', { x: 0, y: 4.45, z: 0 }, identity);
  const lowerMuleTank = addPart(craft, 'tank-m4', upperMuleTank.key, 'stack-bottom', { x: 0, y: 2.55, z: 0 }, identity);
  const mule = addPart(craft, 'eng-mule', lowerMuleTank.key, 'stack-bottom', { x: 0, y: 0.8, z: 0 }, identity);

  // Four large control fins around the lower core tank.
  const coreFinRadius = 1.25 + 0.4;
  for (let index = 0; index < 4; index++) {
    const angle = Math.PI / 4 + index * Math.PI / 2;
    addPart(
      craft,
      'fin-rudder',
      lowerMuleTank.key,
      'surface',
      { x: Math.sin(angle) * coreFinRadius, y: 2.3, z: Math.cos(angle) * coreFinRadius },
      yaw(angle),
      1,
    );
  }

  // Four compact fins on the slim upper-stage tank.
  const upperFinRadius = 0.6 + 0.24;
  for (let index = 0; index < 4; index++) {
    const angle = Math.PI / 4 + index * Math.PI / 2;
    addPart(
      craft,
      'fin-swift',
      podTank.key,
      'surface',
      { x: Math.sin(angle) * upperFinRadius, y: 7.05, z: Math.cos(angle) * upperFinRadius },
      yaw(angle),
      2,
    );
  }

  const boosterKeys: number[] = [];
  const radialDecouplerKeys: number[] = [];
  for (const side of [-1, 1]) {
    const angle = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    const decoupler = addPart(
      craft,
      'dec-radial',
      lowerMuleTank.key,
      'surface',
      { x: side * 1.37, y: 2.7, z: 0 },
      yaw(angle),
      3,
    );
    const booster = addPart(
      craft,
      'srb-torch',
      decoupler.key,
      'surface',
      { x: side * 2.09, y: 2.7, z: 0 },
      identity,
      4,
    );
    addPart(
      craft,
      'nose-s',
      booster.key,
      'stack-top',
      { x: side * 2.09, y: 6.05, z: 0 },
      identity,
      5,
    );
    radialDecouplerKeys.push(decoupler.key);
    boosterKeys.push(booster.key);
  }

  // Stage zero fires first. The Colt ignites in the same event that drops the
  // spent core, because engines are activated before separator graph splitting.
  craft.stages = [
    { partKeys: [mule.key, ...boosterKeys] },
    { partKeys: radialDecouplerKeys },
    { partKeys: [interstage.key, colt.key] },
  ];
  return craft;
}

/** A launch-ready crewed vehicle with a capable, reusable orbital stage. */
export function createOdysseyOrbiter(): Craft {
  const craft = createCraft('Odyssey Orbital Vehicle');

  // The retained spacecraft: docking, attitude control, eclipse reserve,
  // generation, and a deeply throttleable gimballed engine all stay together.
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 16, z: 0 }, identity);
  addPart(craft, 'dock-port-s', pod.key, 'stack-top', { x: 0, y: 16.545, z: 0 }, identity);
  const wheel = addPart(craft, 'wheel-rw', pod.key, 'stack-bottom', { x: 0, y: 15.455, z: 0 }, identity);
  const battery = addPart(craft, 'batt-m', wheel.key, 'stack-bottom', { x: 0, y: 15.195, z: 0 }, identity);
  const serviceTankUpper = addPart(craft, 'tank-s2', battery.key, 'stack-bottom', { x: 0, y: 14.155, z: 0 }, identity);
  const serviceTankMiddle = addPart(craft, 'tank-s2', serviceTankUpper.key, 'stack-bottom', { x: 0, y: 12.355, z: 0 }, identity);
  const serviceTankLower = addPart(craft, 'tank-s2', serviceTankMiddle.key, 'stack-bottom', { x: 0, y: 10.555, z: 0 }, identity);
  const colt = addPart(craft, 'eng-colt', serviceTankLower.key, 'stack-bottom', { x: 0, y: 9.43, z: 0 }, identity);

  const serviceRadius = 0.62;
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2;
    addPart(
      craft,
      'solar-flat',
      serviceTankUpper.key,
      'surface',
      { x: Math.sin(angle) * serviceRadius, y: 14.15, z: Math.cos(angle) * serviceRadius },
      yaw(angle),
      1,
    );
    addPart(
      craft,
      'rcs-quad',
      serviceTankLower.key,
      'surface',
      { x: Math.sin(angle) * serviceRadius, y: 10.85, z: Math.cos(angle) * serviceRadius },
      yaw(angle),
      2,
    );
  }

  // The fitted M-S interstage leaves the fueled Colt service module in orbit.
  const interstage = addPart(craft, 'dec-interstage-ms', colt.key, 'stack-bottom', { x: 0, y: 9.125, z: 0 }, identity);
  const upperTank = addPart(craft, 'tank-m8', interstage.key, 'stack-bottom', { x: 0, y: 7.145, z: 0 }, identity);
  const aspen = addPart(craft, 'eng-aspen', upperTank.key, 'stack-bottom', { x: 0, y: 4.495, z: 0 }, identity);
  const coreSeparator = addPart(craft, 'dec-m', aspen.key, 'stack-bottom', { x: 0, y: 3.645, z: 0 }, identity);

  const boosterTankTop = addPart(craft, 'tank-m8', coreSeparator.key, 'stack-bottom', { x: 0, y: 1.645, z: 0 }, identity);
  const boosterTankUpperMiddle = addPart(craft, 'tank-m8', boosterTankTop.key, 'stack-bottom', { x: 0, y: -2.155, z: 0 }, identity);
  const boosterTankLowerMiddle = addPart(craft, 'tank-m8', boosterTankUpperMiddle.key, 'stack-bottom', { x: 0, y: -5.955, z: 0 }, identity);
  const boosterTankBottom = addPart(craft, 'tank-m8', boosterTankLowerMiddle.key, 'stack-bottom', { x: 0, y: -9.755, z: 0 }, identity);
  const mule = addPart(craft, 'eng-mule', boosterTankBottom.key, 'stack-bottom', { x: 0, y: -12.455, z: 0 }, identity);

  const boosterKeys: number[] = [];
  const radialDecouplerKeys: number[] = [];
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2;
    const decoupler = addPart(
      craft,
      'dec-radial',
      boosterTankLowerMiddle.key,
      'surface',
      { x: Math.sin(angle) * 1.37, y: -8.2, z: Math.cos(angle) * 1.37 },
      yaw(angle),
      3,
    );
    const booster = addPart(
      craft,
      'srb-torch',
      decoupler.key,
      'surface',
      { x: Math.sin(angle) * 2.09, y: -8.2, z: Math.cos(angle) * 2.09 },
      identity,
      4,
    );
    addPart(
      craft,
      'nose-s',
      booster.key,
      'stack-top',
      { x: Math.sin(angle) * 2.09, y: -4.85, z: Math.cos(angle) * 2.09 },
      identity,
      5,
    );
    radialDecouplerKeys.push(decoupler.key);
    boosterKeys.push(booster.key);
  }

  craft.stages = [
    { partKeys: [mule.key, ...boosterKeys] },
    { partKeys: radialDecouplerKeys },
    { partKeys: [coreSeparator.key, aspen.key] },
    { partKeys: [interstage.key, colt.key] },
  ];
  return craft;
}

export const BUILT_IN_CRAFTS: readonly BuiltInCraftDefinition[] = Object.freeze([
  Object.freeze({
    id: 'wayfarer-heavy-demonstrator',
    name: 'Wayfarer Heavy Demonstrator',
    description: 'Two-stage heavy lifter · twin Torch boosters · detachable fitted interstage',
    create: createWayfarerDemonstrator,
  }),
  Object.freeze({
    id: 'odyssey-orbital-vehicle',
    name: 'Odyssey Orbital Vehicle',
    description: 'Three-stage crewed orbiter · gimballed propulsion · solar service module with reserve fuel',
    create: createOdysseyOrbiter,
  }),
]);
