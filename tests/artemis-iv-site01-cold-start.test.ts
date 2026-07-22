import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeArtemisIvCheckpoint } from '../src/missions/artemisIv/checkpoints';
import { vesselForArtemisIvRole } from '../src/missions/artemisIv/mission';
import { GameState, PHYSICS_DT } from '../src/sim/state';

const site01Bytes = Uint8Array.from(readFileSync(new URL(
  '../assets/planets/generated/moon/site01/height-u16.bin',
  import.meta.url,
)));

afterEach(() => vi.unstubAllGlobals());

describe('Artemis IV Site 01 cold checkpoints', () => {
  it('keeps the Chapter 6 and 7 lander settled on promoted Site 01 terrain', async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/planets/generated/moon/site01/height-u16.bin') {
        return new Response(site01Bytes.slice().buffer, { status: 200 });
      }
      return originalFetch(input, init);
    }));

    for (const chapter of [6, 7] as const) {
      const game = new GameState('sandbox', { persistence: 'session-only' });
      const moon = game.universe.get('moon');
      const authority = await game.prepareFlightAuthority(moon, 'moon-site01');
      expect(authority.fallbackReason).toBeUndefined();

      const state = initializeArtemisIvCheckpoint(chapter, game);
      const lander = vesselForArtemisIvRole(state, 'hls')!;
      for (let step = 0; step < 1_000; step++) game.update(PHYSICS_DT);

      expect(game.vessels).toContain(lander);
      expect(game.lastDestruction).toBeNull();
      expect(lander.runtime.situation).toBe('landed');
      expect(lander.runtime.externalLandingFootprint).toMatchObject({
        contactCount: 4,
        tipped: false,
      });
      expect(lander.runtime.externalLandingFootprint!.stableForMs)
        .toBeGreaterThanOrEqual(1_500);
    }
  }, 20_000);
});
