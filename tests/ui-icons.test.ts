import { describe, expect, it } from 'vitest';
import { ICON_PATHS, UTILITY_ICON_NAMES } from '../src/ui/icons';

describe('utility icon registry', () => {
  it('covers every approved launcher without text glyphs', () => {
    expect(UTILITY_ICON_NAMES).toEqual([
      'science', 'save', 'account', 'settings', 'keyboard', 'orbit',
      'surface', 'vessel', 'alarm', 'transfer', 'fleet', 'log',
    ]);
    for (const name of UTILITY_ICON_NAMES) {
      expect(ICON_PATHS[name].length).toBeGreaterThan(0);
      expect(ICON_PATHS[name].join(' ')).not.toMatch(/<text|status|dot/i);
    }
  });
});
