import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, UTILITY_ICON_NAMES } from '../src/ui/icons';

const kitSource = readFileSync(new URL('../src/ui/kit.ts', import.meta.url), 'utf8');

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

  it('keeps launcher targets, tooltips, focus, and edge placement accessible', () => {
    expect(kitSource).toMatch(/\.k-icon-btn\s*\{[^}]*width:36px;[^}]*height:36px;/s);
    expect(kitSource).toMatch(/\.k-icon-btn:focus-visible\s*\{[^}]*outline:2px solid var\(--ui-accent\);[^}]*outline-offset:2px;/s);
    expect(kitSource).not.toMatch(/\.k-icon-btn:focus-visible\s*\{[^}]*outline:none;/s);
    expect(kitSource).toMatch(
      /\.ed-utility-host,\.hud-utility-host\s*\{[^}]*left:0;[^}]*bottom:0;/s,
    );
    expect(kitSource).toMatch(
      /\.ed-utility-host \.k-launcher,\.hud-utility-host \.k-launcher\s*\{[^}]*flex-direction:column;[^}]*flex-wrap:nowrap;/s,
    );
    expect(kitSource).toMatch(
      /\.ed-utility-host \.k-icon-tooltip,\s*\.hud-utility-host \.k-icon-tooltip\s*\{[^}]*left:calc\(100% \+ 7px\);[^}]*top:50%;[^}]*bottom:auto;/s,
    );
    expect(kitSource).toMatch(
      /\.ed-utility-host \.k-icon-btn:hover \.k-icon-tooltip,\s*\.ed-utility-host \.k-icon-btn:focus-visible \.k-icon-tooltip,\s*\.hud-utility-host \.k-icon-btn:hover \.k-icon-tooltip,\s*\.hud-utility-host \.k-icon-btn:focus-visible \.k-icon-tooltip/s,
    );
    expect(kitSource).toMatch(/\.hud-events\s*\{[^}]*top:\s*88px;/s);
    expect(kitSource).toMatch(/@media \(max-width:820px\), \(pointer:coarse\)\s*\{[\s\S]*?\.k-icon-btn\s*\{[^}]*width:42px;[^}]*height:42px;/);
  });
});
