import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'assets/sol/constants-source.json');
const outputPath = path.join(repoRoot, 'src/generated/checked-sol-constants.ts');
const sourceText = await readFile(sourcePath, 'utf8');
const source = JSON.parse(sourceText);
const DEG = Math.PI / 180;
const J2000_OBLIQUITY_DEGREES = 23.439291111;
const SOL_BODY_NAIF_IDS = new Map([
  ['sun', 10],
  ['mercury', 199],
  ['venus', 299],
  ['earth', 399],
  ['moon', 301],
  ['mars', 499],
  ['jupiter', 599],
  ['callisto', 504],
]);
const SOL_BODY_IDS = [...SOL_BODY_NAIF_IDS.keys()];

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
}

function assertClose(actual, expected, label, tolerance = 1e-9) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance * Math.max(1, Math.abs(expected))) {
    throw new Error(`${label} differs from the pinned kernel: expected ${expected}, got ${actual}`);
  }
}

function kernelNumbers(kernel, key) {
  const expression = new RegExp(`\\b${key}\\s*=\\s*\\(([^)]*)\\)`, 'gi');
  const matches = [...kernel.matchAll(expression)];
  if (matches.length === 0) throw new Error(`Missing ${key} in the pinned NAIF kernels`);
  return matches.at(-1)[1]
    .trim()
    .split(/\s+/)
    .map((value) => Number(value.replace(/[dD]/g, 'E')));
}

function verifyDigest(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
}

function equatorialDirectionToEcliptic(x, y, z) {
  const obliquity = J2000_OBLIQUITY_DEGREES * DEG;
  return [
    x,
    Math.cos(obliquity) * y + Math.sin(obliquity) * z,
    -Math.sin(obliquity) * y + Math.cos(obliquity) * z,
  ];
}

function equatorialPoleToEcliptic(rightAscensionDegrees, declinationDegrees) {
  const ra = rightAscensionDegrees * DEG;
  const dec = declinationDegrees * DEG;
  const [x, y, z] = equatorialDirectionToEcliptic(
    Math.cos(ra) * Math.cos(dec),
    Math.sin(ra) * Math.cos(dec),
    Math.sin(dec),
  );
  return {
    rightAscensionDegrees: Math.atan2(y, x) / DEG,
    declinationDegrees: Math.asin(Math.max(-1, Math.min(1, z))) / DEG,
  };
}

function convertedPrimeMeridianDegrees(rightAscensionDegrees, declinationDegrees, meridianDegrees) {
  const ra = rightAscensionDegrees * DEG;
  const dec = declinationDegrees * DEG;
  const w = meridianDegrees * DEG;
  const x0 = [-Math.sin(ra), Math.cos(ra), 0];
  const y0 = [-Math.cos(ra) * Math.sin(dec), -Math.sin(ra) * Math.sin(dec), Math.cos(dec)];
  const equatorialX = [
    x0[0] * Math.cos(w) + y0[0] * Math.sin(w),
    x0[1] * Math.cos(w) + y0[1] * Math.sin(w),
    y0[2] * Math.sin(w),
  ];
  const eclipticX = equatorialDirectionToEcliptic(...equatorialX);
  const pole = equatorialPoleToEcliptic(rightAscensionDegrees, declinationDegrees);
  const eclipticRa = pole.rightAscensionDegrees * DEG;
  const eclipticDec = pole.declinationDegrees * DEG;
  const eclipticX0 = [-Math.sin(eclipticRa), Math.cos(eclipticRa), 0];
  const eclipticY0 = [
    -Math.cos(eclipticRa) * Math.sin(eclipticDec),
    -Math.sin(eclipticRa) * Math.sin(eclipticDec),
    Math.cos(eclipticDec),
  ];
  const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  return Math.atan2(dot(eclipticX, eclipticY0), dot(eclipticX, eclipticX0)) / DEG;
}

function wrapDeltaDegrees(value) {
  return ((value + 540) % 360) - 180;
}

function compileReferenceFrame(frame, periodicAtEpoch = { ra: 0, dec: 0, pm: 0 }) {
  const equatorialEpochRa = frame.poleRightAscensionDegrees + periodicAtEpoch.ra;
  const equatorialEpochDec = frame.poleDeclinationDegrees + periodicAtEpoch.dec;
  const epoch = equatorialPoleToEcliptic(equatorialEpochRa, equatorialEpochDec);
  const nextCentury = equatorialPoleToEcliptic(
    equatorialEpochRa + frame.poleRightAscensionRateDegreesPerCentury,
    equatorialEpochDec + frame.poleDeclinationRateDegreesPerCentury,
  );
  const epochPrimeMeridian = convertedPrimeMeridianDegrees(
    equatorialEpochRa,
    equatorialEpochDec,
    frame.primeMeridianDegrees + periodicAtEpoch.pm,
  );
  const nextDayPrimeMeridian = convertedPrimeMeridianDegrees(
    equatorialEpochRa + frame.poleRightAscensionRateDegreesPerCentury / 36_525,
    equatorialEpochDec + frame.poleDeclinationRateDegreesPerCentury / 36_525,
    frame.primeMeridianDegrees + periodicAtEpoch.pm + frame.primeMeridianRateDegreesPerDay,
  );
  const wrappedDailyRate = wrapDeltaDegrees(nextDayPrimeMeridian - epochPrimeMeridian);
  const dailyRate = wrappedDailyRate + 360 * Math.round(
    (frame.primeMeridianRateDegreesPerDay - wrappedDailyRate) / 360,
  );
  return {
    inertialFrame: 'ecliptic-j2000',
    poleRightAscensionDegrees: epoch.rightAscensionDegrees,
    poleRightAscensionRateDegreesPerCentury: wrapDeltaDegrees(
      nextCentury.rightAscensionDegrees - epoch.rightAscensionDegrees,
    ),
    poleDeclinationDegrees: epoch.declinationDegrees,
    poleDeclinationRateDegreesPerCentury:
      nextCentury.declinationDegrees - epoch.declinationDegrees,
    primeMeridianDegrees: epochPrimeMeridian,
    primeMeridianRateDegreesPerDay: dailyRate,
    primeMeridianQuadraticDegreesPerCentury2: frame.primeMeridianQuadraticDegreesPerCentury2,
  };
}

function obliquityRadians(referenceFrame, orbit) {
  const ra = referenceFrame.poleRightAscensionDegrees * DEG;
  const dec = referenceFrame.poleDeclinationDegrees * DEG;
  const pole = [Math.cos(ra) * Math.cos(dec), Math.sin(ra) * Math.cos(dec), Math.sin(dec)];
  const normal = orbit
    ? [
      Math.sin(orbit.inclinationRadians) * Math.sin(orbit.longitudeAscendingNodeRadians),
      -Math.sin(orbit.inclinationRadians) * Math.cos(orbit.longitudeAscendingNodeRadians),
      Math.cos(orbit.inclinationRadians),
    ]
    : [0, 0, 1];
  const dot = pole[0] * normal[0] + pole[1] * normal[1] + pole[2] * normal[2];
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

if (source.schemaVersion !== 1 || source.epoch !== 'J2000') {
  throw new Error('Unsupported Sol constants source schema or epoch');
}
if (!Array.isArray(source.authorities) || source.authorities.length < 3) {
  throw new Error('Sol constants require pinned authority metadata');
}
for (const authority of source.authorities) {
  if (!authority.id || !authority.url || !authority.units) {
    throw new Error('Every Sol constants authority requires id, URL, and units');
  }
  if (authority.sha256 && !/^[a-f0-9]{64}$/.test(authority.sha256)) {
    throw new Error(`${authority.id} has an invalid SHA-256 digest`);
  }
}
finitePositive(source.astronomicalUnitMeters, 'astronomicalUnitMeters');
for (const id of SOL_BODY_IDS) {
  const body = source.bodies?.[id];
  if (!body) throw new Error(`Missing ${id} constants`);
  finitePositive(body.meanRadiusMeters, `${id}.meanRadiusMeters`);
  finitePositive(body.gmMeters3PerSecond2, `${id}.gmMeters3PerSecond2`);
  for (const [key, value] of Object.entries(body.referenceFrame ?? {})) {
    if (!Number.isFinite(value)) throw new Error(`${id}.referenceFrame.${key} must be finite`);
  }
  for (const [key, value] of Object.entries(body.orbit ?? {})) {
    if (!Number.isFinite(value)) throw new Error(`${id}.orbit.${key} must be finite`);
  }
}

const pckAuthority = source.authorities.find((entry) => entry.id === 'naif-pck00011');
const gmAuthority = source.authorities.find((entry) => entry.id === 'naif-gm-de440');
if (!pckAuthority?.sha256 || !gmAuthority?.sha256) throw new Error('Pinned NAIF authorities are missing');
const pckBytes = await readFile(path.join(repoRoot, 'assets/sol/sources/naif-pck00011.tpc'))
  .catch(() => { throw new Error('Pinned PCK kernel missing; run npm run fetch:sol-constants'); });
const gmBytes = await readFile(path.join(repoRoot, 'assets/sol/sources/naif-gm-de440.tpc'))
  .catch(() => { throw new Error('Pinned GM kernel missing; run npm run fetch:sol-constants'); });
verifyDigest(pckBytes, pckAuthority.sha256, pckAuthority.id);
verifyDigest(gmBytes, gmAuthority.sha256, gmAuthority.id);
const pck = pckBytes.toString('utf8');
const gm = gmBytes.toString('utf8');

for (const [id, naifId] of SOL_BODY_NAIF_IDS) {
  const body = source.bodies[id];
  const radii = kernelNumbers(pck, `BODY${naifId}_RADII`);
  const gmKm = kernelNumbers(gm, `BODY${naifId}_GM`)[0];
  const poleRa = kernelNumbers(pck, `BODY${naifId}_POLE_RA`);
  const poleDec = kernelNumbers(pck, `BODY${naifId}_POLE_DEC`);
  const pm = kernelNumbers(pck, `BODY${naifId}_PM`);
  assertClose(radii.reduce((sum, radius) => sum + radius, 0) / radii.length * 1_000,
    body.meanRadiusMeters, `${id}.meanRadiusMeters`);
  assertClose(gmKm * 1e9, body.gmMeters3PerSecond2, `${id}.gmMeters3PerSecond2`);
  assertClose(poleRa[0], body.referenceFrame.poleRightAscensionDegrees, `${id}.poleRightAscensionDegrees`);
  assertClose(poleRa[1], body.referenceFrame.poleRightAscensionRateDegreesPerCentury,
    `${id}.poleRightAscensionRateDegreesPerCentury`);
  assertClose(poleDec[0], body.referenceFrame.poleDeclinationDegrees, `${id}.poleDeclinationDegrees`);
  assertClose(poleDec[1], body.referenceFrame.poleDeclinationRateDegreesPerCentury,
    `${id}.poleDeclinationRateDegreesPerCentury`);
  assertClose(pm[0], body.referenceFrame.primeMeridianDegrees, `${id}.primeMeridianDegrees`);
  assertClose(pm[1], body.referenceFrame.primeMeridianRateDegreesPerDay, `${id}.primeMeridianRateDegreesPerDay`);
  assertClose(pm[2], body.referenceFrame.primeMeridianQuadraticDegreesPerCentury2,
    `${id}.primeMeridianQuadraticDegreesPerCentury2`);
  const hasEquatorialRadius = Number.isFinite(body.equatorialRadiusMeters);
  const hasPolarRadius = Number.isFinite(body.polarRadiusMeters);
  if (hasEquatorialRadius !== hasPolarRadius) {
    throw new Error(`${id} must author equatorial and polar radii together`);
  }
  if (hasEquatorialRadius) {
    assertClose(radii[0] * 1_000, body.equatorialRadiusMeters, `${id}.equatorialRadiusMeters`);
    assertClose(radii[2] * 1_000, body.polarRadiusMeters, `${id}.polarRadiusMeters`);
  }
}

function periodicTermsAtEpoch(naifId) {
  const systemId = Math.floor(naifId / 100);
  let angles;
  let ra;
  let dec;
  let pm;
  try {
    angles = kernelNumbers(pck, `BODY${systemId}_NUT_PREC_ANGLES`);
    ra = kernelNumbers(pck, `BODY${naifId}_NUT_PREC_RA`);
    dec = kernelNumbers(pck, `BODY${naifId}_NUT_PREC_DEC`);
    pm = kernelNumbers(pck, `BODY${naifId}_NUT_PREC_PM`);
  } catch {
    return { ra: 0, dec: 0, pm: 0 };
  }
  const termCount = Math.max(ra.length, dec.length, pm.length);
  if (angles.length < termCount * 2) {
    throw new Error(`BODY${naifId} has inconsistent periodic orientation terms`);
  }
  const periodic = { ra: 0, dec: 0, pm: 0 };
  for (let index = 0; index < termCount; index++) {
    const angle = angles[index * 2] * DEG;
    periodic.ra += (ra[index] ?? 0) * Math.sin(angle);
    periodic.dec += (dec[index] ?? 0) * Math.cos(angle);
    periodic.pm += (pm[index] ?? 0) * Math.sin(angle);
  }
  return periodic;
}

const lunarAngles = kernelNumbers(pck, 'BODY3_NUT_PREC_ANGLES');
assertClose(lunarAngles[0] * DEG, source.bodies.moon.orbit.longitudeAscendingNodeRadians,
  'moon.orbit.longitudeAscendingNodeRadians');

const compiled = structuredClone(source);
compiled.compiledInertialFrame = 'ecliptic-j2000';
compiled.j2000ObliquityDegrees = J2000_OBLIQUITY_DEGREES;
for (const id of SOL_BODY_IDS) {
  const periodicBody = id === 'moon' || id === 'jupiter' || id === 'callisto';
  compiled.bodies[id].referenceFrame = compileReferenceFrame(
    source.bodies[id].referenceFrame,
    periodicBody ? periodicTermsAtEpoch(SOL_BODY_NAIF_IDS.get(id)) : undefined,
  );
  compiled.bodies[id].obliquityRadians = obliquityRadians(
    compiled.bodies[id].referenceFrame,
    compiled.bodies[id].orbit,
  );
}

const digest = createHash('sha256').update(sourceText).digest('hex');
const generated = `/** Generated by scripts/compile-sol-constants.mjs. Do not edit. */\n`
  + `export const SOL_CONSTANTS_SOURCE_SHA256 = '${digest}' as const;\n`
  + `export const CHECKED_SOL_CONSTANTS = ${JSON.stringify(compiled, null, 2)} as const;\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');
  if (current !== generated) throw new Error('checked-sol-constants.ts is stale; run npm run compile:sol-constants');
} else {
  await writeFile(outputPath, generated);
}
