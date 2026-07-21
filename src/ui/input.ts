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

export type BindingScreen = 'flight' | 'editor' | 'mission-replay';

export interface KeyBinding {
  /** Stable remap key; derived from screen/group/label when omitted. */
  id?: string;
  /** `KeyboardEvent.code` (e.g. 'KeyM', 'F5', 'Slash'); '' for doc-only rows. */
  code: string;
  /** Requires Shift held; unshifted bindings fire only without Shift. */
  shift?: boolean;
  /** Requires Alt/Option held; unmodified bindings fire only without Alt. */
  alt?: boolean;
  /** Requires Control/Command held. */
  ctrl?: boolean;
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
export function keyDisplay(binding: Pick<KeyBinding, 'code' | 'shift' | 'alt' | 'ctrl' | 'keyLabel'>): string {
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
  const modifiers = [binding.ctrl ? 'Ctrl' : '', binding.alt ? 'Alt' : '', binding.shift ? 'Shift' : ''].filter(Boolean);
  return modifiers.length ? `${modifiers.join('+')}+${base}` : base;
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
  alt = false,
  ctrl = false,
): KeyBinding | null {
  let anyMatch: KeyBinding | null = null;
  for (const b of bindings) {
    if (
      !b.handler
      || b.code !== code
      || (b.shift ?? false) !== shift
      || (b.alt ?? false) !== alt
      || (b.ctrl ?? false) !== ctrl
    ) continue;
    if (b.screen === screen) return b;
    if (b.screen === 'any' && !anyMatch) anyMatch = b;
  }
  return anyMatch;
}

export class InputService {
  private readonly bindings: KeyBinding[] = [];
  private remaps: Record<string, { code: string; shift: boolean; alt: boolean; ctrl: boolean }> = {};
  private onRemapsChanged: ((remaps: Record<string, { code: string; shift: boolean; alt: boolean; ctrl: boolean }>) => void) | null = null;

  private idOf(binding: KeyBinding): string {
    return binding.id ?? `${binding.screen}:${binding.group}:${binding.label}`;
  }

  configureRemaps(
    remaps: Record<string, { code: string; shift: boolean; alt: boolean; ctrl: boolean }>,
    onChanged: (next: Record<string, { code: string; shift: boolean; alt: boolean; ctrl: boolean }>) => void,
  ): void {
    this.remaps = { ...remaps };
    this.onRemapsChanged = onChanged;
  }

  add(...bindings: KeyBinding[]): void {
    this.bindings.push(...bindings);
  }

  /** Dispatch a keydown; returns true when a binding handled it. */
  dispatch(e: KeyboardEvent, screen: BindingScreen): boolean {
    const b = findBinding(this.effectiveBindings(), screen, e.code, e.shiftKey, e.altKey, e.ctrlKey || e.metaKey);
    if (!b) return false;
    if (b.preventDefault) e.preventDefault();
    b.handler!(e);
    return true;
  }

  /** All bindings visible on a screen (including doc-only), for the cheat sheet. */
  list(screen: BindingScreen): KeyBinding[] {
    return this.effectiveBindings().filter((b) => b.screen === screen || b.screen === 'any');
  }

  remappable(): KeyBinding[] {
    return this.effectiveBindings().filter((binding) => binding.handler && binding.code);
  }

  remap(binding: KeyBinding, event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): void {
    this.remaps[this.idOf(binding)] = {
      code: event.code,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
    };
    this.onRemapsChanged?.({ ...this.remaps });
  }

  resetRemaps(): void {
    this.remaps = {};
    this.onRemapsChanged?.({});
  }

  private effectiveBindings(): KeyBinding[] {
    return this.bindings.map((binding) => {
      const remap = this.remaps[this.idOf(binding)];
      return remap ? { ...binding, ...remap, keyLabel: undefined } : binding;
    });
  }
}
