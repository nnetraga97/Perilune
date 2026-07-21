import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sourceLockJson from '../assets/missions/artemis-iv/sources/source.lock.json';
import referenceTrackJson from '../src/generated/artemis-iv-reference-track.json';
import {
  assertArtemisReferenceArtifact,
  assertArtemisSourceLock,
  sourceByArtemisId,
  validateArtemisReferenceArtifact,
  validateArtemisSourceLock,
} from '../scripts/lib/artemis-source-registry.mjs';

const root = resolve(import.meta.dirname, '..');
const artifactPath = resolve(root, 'src/generated/artemis-iv-reference-track.json');
const artifactBytes = readFileSync(artifactPath);
const lock = assertArtemisSourceLock(sourceLockJson);
const artifact = assertArtemisReferenceArtifact(lock, referenceTrackJson, artifactBytes);

describe('Artemis IV source provenance', () => {
  it('locks every authoring kernel by URL, byte length, and real SHA-256', () => {
    const kernels = lock.sources.filter((source) => source.kind === 'kernel');
    expect(kernels.map((source) => source.id)).toEqual([
      'naif-dsg-nrho-spk-2018',
      'jpl-de440s-spk-2020',
      'naif-leapseconds-0012',
    ]);
    for (const source of kernels) {
      expect(new URL(source.url).hostname).toBe('naif.jpl.nasa.gov');
      expect(source.artifact?.byteLength).toBeGreaterThan(0);
      expect(source.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(sourceByArtemisId(lock, 'naif-dsg-nrho-spk-2018').artifact).toEqual({
      filename: 'receding_horiz_3189_1burnApo_DiffCorr_15yr.bsp',
      byteLength: 41_020_416,
      sha256: '114bf4bf418237d28b8945e05d7a04d90358199f62d50f9bf14f38b13985f8ec',
    });
  });

  it('binds the checked runtime artifact to its exact bytes and sample states', () => {
    expect(createHash('sha256').update(artifactBytes).digest('hex'))
      .toBe(lock.referenceTrajectory.generatedArtifact.sha256);
    expect(artifactBytes.byteLength).toBe(lock.referenceTrajectory.generatedArtifact.byteLength);
    expect(validateArtemisReferenceArtifact(lock, artifact, artifactBytes)).toEqual([]);
    expect(artifact.generatedFrom.kernelArtifacts.map((kernel) => kernel.sha256)).toEqual(
      lock.referenceTrajectory.kernelSourceIds.map(
        (sourceId) => sourceByArtemisId(lock, sourceId).artifact?.sha256,
      ),
    );
    const generator = lock.referenceTrajectory.generatedArtifact;
    for (const [path, byteLength, sha256] of [
      [generator.script, generator.scriptByteLength, generator.scriptSha256],
      [generator.requirements, generator.requirementsByteLength, generator.requirementsSha256],
    ] as const) {
      const bytes = readFileSync(resolve(root, path));
      expect(bytes.byteLength).toBe(byteLength);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    }
  });

  it('contains an open, Moon-centered SI revolution inside the published NRHO envelope', () => {
    expect(artifact.coordinateFrame).toMatchObject({
      id: 'MOON_J2000', originNaifId: 301, axes: 'J2000', positionUnits: 'm', velocityUnits: 'm/s',
    });
    expect(artifact.loopMode).toBe('open-reference-revolution');
    expect(artifact.metrics.sampleCount).toBe(artifact.samples.length);
    expect(artifact.metrics.periodDays).toBeCloseTo(6.562, 2);
    expect(artifact.metrics.minimumRadiusMeters).toBeGreaterThanOrEqual(3_196_000);
    expect(artifact.metrics.minimumRadiusMeters).toBeLessThanOrEqual(3_557_000);
    expect(artifact.metrics.maximumRadiusMeters).toBeGreaterThan(65_000_000);
    expect(artifact.metrics.maximumRadiusMeters).toBeLessThan(75_000_000);
  });

  it('states the fidelity boundary without turning source dates into mission dates', () => {
    expect(artifact.fidelity).toBe('reference-trajectory');
    expect(artifact.disclaimer.toLowerCase()).toContain('not an artemis iv flight trajectory');
    expect(lock.referenceTrajectory.selection.method.toLowerCase()).toContain('not artemis iv mission dates');
    expect(sourceByArtemisId(lock, 'ntrs-nrho-rendezvous-20230000757').supportedClaims)
      .toContain('The report supports operational concepts, not an exact Artemis IV rendezvous ephemeris.');
  });

  it('rejects a changed source host or an unlocked kernel checksum', () => {
    const changedHost = structuredClone(sourceLockJson);
    changedHost.sources[0].url = 'https://example.com/artemis-iv';
    expect(validateArtemisSourceLock(changedHost)).toContain(
      'sources[0].url is outside the HTTPS allowlist',
    );

    const changedDigest = structuredClone(sourceLockJson);
    const kernel = changedDigest.sources.find((source) => source.kind === 'kernel');
    if (!kernel?.artifact) throw new Error('test fixture has no kernel');
    kernel.artifact.sha256 = 'not-a-digest';
    expect(validateArtemisSourceLock(changedDigest)).toContain(
      'sources[7].artifact.sha256 must be lowercase SHA-256',
    );
  });

  it('rejects changed state data even when metadata is left untouched', () => {
    const changed = structuredClone(referenceTrackJson);
    changed.samples[10].positionM[0] += 1;
    expect(validateArtemisReferenceArtifact(lock, changed)).toContain(
      'samplesSha256 does not match the binary-encoded sample states',
    );
  });
});
