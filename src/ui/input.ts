/**
 * Declarative keyboard input for the game shell.
 *
 * One binding table drives key dispatch, the `?` cheat-sheet overlay, and —
 * later — the settings remap UI, so the documented keys can never drift from
 * the behavior (spec: 2026-07-13 UI redesign, workstream 1).
 *
 * Held keys polled every frame by the flight loop (attitude, throttle, RCS
 * translation) register as documentation-only entries: they appear in the
 * cheat sheet but have no keydown handler.
 */

export type BindingScreen = 'flight' | 'editor';

export interface KeyBinding {
  /** `KeyboardEvent.code` (e.g. 'KeyM', 'F5', 'Slash'); '' for doc-only rows. */
  code: string;
  /** Requires Shift held; unshifted bindings fire only without Shift. */
  shift?: boolean;
  screen: BindingScreen | 'any';
  /** Cheat-sheet section heading. */
  group: string;
  /** What the key does, for the cheat sheet and remap UI. */
  label: string;
  /** Cheat-sheet key text; defaults to a display form of `code`. */
  keyLabel?: string;
  /** Call preventDefault() on the event when handled. */
  preventDefault?: boolean;
  /** Omitted for documentation-only entries (frame-loop held keys). */
  handler?: (e: KeyboardEvent) => void;
}

/** Human-readable key text for a binding (pure; unit-tested). */
export function keyDisplay(binding: Pick<KeyBinding, 'code' | 'shift' | 'keyLabel'>): string {
  if (binding.keyLabel) return binding.keyLabel;
  let base = binding.code;
  if (base.startsWith('Key')) base = base.slice(3);
  else if (base.startsWith('Digit')) base = base.slice(5);
  else {
    const named: Record<string, string> = {
      Comma: ',',
      Period: '.',
      Slash: '/',
      BracketLeft: '[',
      BracketRight: ']',
      Space: 'Space',
      Backspace: 'Bksp',
    };
    base = named[base] ?? base;
  }
  return binding.shift ? `Shift+${base}` : base;
}

/**
 * Find the handler-bearing binding for a key event (pure; unit-tested).
 * Screen-specific bindings win over 'any'; shift must match exactly.
 */
export function findBinding(
  bindings: readonly KeyBinding[],
  screen: BindingScreen,
  code: string,
  shift: boolean,
): KeyBinding | null {
  let anyMatch: KeyBinding | null = null;
  for (const b of bindings) {
    if (!b.handler || b.code !== code || (b.shift ?? false) !== shift) continue;
    if (b.screen === screen) return b;
    if (b.screen === 'any' && !anyMatch) anyMatch = b;
  }
  return anyMatch;
}

export class InputService {
  private readonly bindings: KeyBinding[] = [];

  add(...bindings: KeyBinding[]): void {
    this.bindings.push(...bindings);
  }

  /** Dispatch a keydown; returns true when a binding handled it. */
  dispatch(e: KeyboardEvent, screen: BindingScreen): boolean {
    const b = findBinding(this.bindings, screen, e.code, e.shiftKey);
    if (!b) return false;
    if (b.preventDefault) e.preventDefault();
    b.handler!(e);
    return true;
  }

  /** All bindings visible on a screen (including doc-only), for the cheat sheet. */
  list(screen: BindingScreen): KeyBinding[] {
    return this.bindings.filter((b) => b.screen === screen || b.screen === 'any');
  }
}
