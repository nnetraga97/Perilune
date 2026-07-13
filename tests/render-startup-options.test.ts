import { describe, expect, it } from 'vitest';
import { parseRenderStartupOptions } from '../src/render/renderStartupOptions';

describe('parseRenderStartupOptions', () => {
  it.each([
    ['', 'medium'],
    ['?quality=medium', 'medium'],
    ['?quality=high', 'high'],
    ['?quality=low', 'medium'],
    ['?quality=HIGH', 'medium'],
    ['?quality=unknown', 'medium'],
  ] as const)('parses %s with a deterministic %s tier', (search, quality) => {
    expect(parseRenderStartupOptions(search).quality).toBe(quality);
  });

  it('enables detailed diagnostics only for the exact value 1', () => {
    expect(parseRenderStartupOptions('?renderDebug=1').renderDebug).toBe(true);
    for (const search of ['', '?renderDebug=true', '?renderDebug=0', '?renderDebug=01', '?renderDebug=1%20']) {
      expect(parseRenderStartupOptions(search).renderDebug).toBe(false);
    }
  });

  it('returns an immutable startup contract', () => {
    expect(Object.isFrozen(parseRenderStartupOptions('?quality=high&renderDebug=1'))).toBe(true);
  });
});
