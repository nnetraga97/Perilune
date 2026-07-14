/**
 * Binding-table dispatch logic for the declarative input service
 * (spec: 2026-07-13 UI redesign, workstream 1). DOM-free: findBinding and
 * keyDisplay are pure over plain binding objects.
 */
import { describe, expect, it } from 'vitest';
import { findBinding, keyDisplay, type KeyBinding } from '../src/ui/input';

const noop = () => {};

function binding(partial: Partial<KeyBinding>): KeyBinding {
  return { code: 'KeyM', screen: 'flight', group: 'g', label: 'l', handler: noop, ...partial };
}

describe('findBinding', () => {
  it('matches code and screen', () => {
    const b = binding({ code: 'KeyM', screen: 'flight', label: 'map' });
    expect(findBinding([b], 'flight', 'KeyM', false)?.label).toBe('map');
    expect(findBinding([b], 'editor', 'KeyM', false)).toBeNull();
    expect(findBinding([b], 'flight', 'KeyN', false)).toBeNull();
  });

  it('keeps the same key independent per screen (X: cut throttle vs symmetry)', () => {
    const bindings = [
      binding({ code: 'KeyX', screen: 'flight', label: 'cut throttle' }),
      binding({ code: 'KeyX', screen: 'editor', label: 'symmetry' }),
    ];
    expect(findBinding(bindings, 'flight', 'KeyX', false)?.label).toBe('cut throttle');
    expect(findBinding(bindings, 'editor', 'KeyX', false)?.label).toBe('symmetry');
  });

  it('treats shifted keys as distinct bindings (/ vs ?)', () => {
    const bindings = [
      binding({ code: 'Slash', screen: 'flight', label: 'cancel warp' }),
      binding({ code: 'Slash', shift: true, screen: 'any', label: 'cheat sheet' }),
    ];
    expect(findBinding(bindings, 'flight', 'Slash', false)?.label).toBe('cancel warp');
    expect(findBinding(bindings, 'flight', 'Slash', true)?.label).toBe('cheat sheet');
    // Unshifted binding must not fire when Shift is held and no shifted binding exists.
    expect(findBinding([bindings[0]], 'flight', 'Slash', true)).toBeNull();
  });

  it('prefers screen-specific bindings over any-screen bindings', () => {
    const bindings = [
      binding({ code: 'KeyH', screen: 'any', label: 'generic' }),
      binding({ code: 'KeyH', screen: 'flight', label: 'specific' }),
    ];
    expect(findBinding(bindings, 'flight', 'KeyH', false)?.label).toBe('specific');
    expect(findBinding(bindings, 'editor', 'KeyH', false)?.label).toBe('generic');
  });

  it('skips documentation-only entries (no handler)', () => {
    const doc: KeyBinding = { code: 'KeyW', screen: 'flight', group: 'g', label: 'pitch' };
    expect(findBinding([doc], 'flight', 'KeyW', false)).toBeNull();
  });
});

describe('keyDisplay', () => {
  it('strips Key/Digit prefixes', () => {
    expect(keyDisplay({ code: 'KeyM' })).toBe('M');
    expect(keyDisplay({ code: 'Digit5' })).toBe('5');
  });

  it('maps named punctuation codes', () => {
    expect(keyDisplay({ code: 'Comma' })).toBe(',');
    expect(keyDisplay({ code: 'Period' })).toBe('.');
    expect(keyDisplay({ code: 'BracketLeft' })).toBe('[');
  });

  it('honors shift and explicit key labels', () => {
    expect(keyDisplay({ code: 'Slash', shift: true })).toBe('Shift+/');
    expect(keyDisplay({ code: 'Slash', shift: true, keyLabel: '?' })).toBe('?');
    expect(keyDisplay({ code: 'F5' })).toBe('F5');
  });
});
