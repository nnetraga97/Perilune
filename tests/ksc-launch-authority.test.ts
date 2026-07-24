import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import kscLaunch from '../assets/planets/ksc-launch-authority.json';
import { GameState } from '../src/sim/state';

const authorityBytes = readFileSync(resolve(
  import.meta.dirname,
  '../assets/planets/generated/earth/ksc/height-u16.bin',
));

describe('bundled KSC launch authority', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prepares the promoted Earth region from the same-origin artifact without contacting USGS', async () => {
    const requests: string[] = [];
    const artifactUrl = `/planets/${kscLaunch.path}?v=${kscLaunch.sha256}`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url !== artifactUrl) throw new Error(`Unexpected external request: ${url}`);
      return new Response(authorityBytes, { status: 200 });
    }));

    const game = new GameState();
    const earth = game.universe.get('earth');
    const authority = await game.prepareFlightAuthority(earth, 'ksc-launch');

    expect(requests).toEqual([artifactUrl]);
    expect(authority.mode).toBe('promoted-region');
    expect(authority.datasetId).toBe(kscLaunch.datasetId);
    expect(authority.version).toBe(kscLaunch.version);
    expect(authority.fallbackReason).toBeUndefined();
    expect(authority.region?.width).toBe(384);
    expect(authority.region?.height).toBe(256);
    expect(authority.region?.samples).toHaveLength(384 * 256);
    expect(authority.coverage[0]).toBeLessThan(-80.6209);
    expect(authority.coverage[2]).toBeGreaterThan(-80.6209);
    expect(authority.coverage[1]).toBeLessThan(28.6272);
    expect(authority.coverage[3]).toBeGreaterThan(28.6272);
  });
});
