/**
 * Keybinding cheat sheet (`?`): an overlay generated from the live binding
 * table, grouped by section, filtered to the current screen. Because it
 * renders the same table the dispatcher uses, it cannot drift from behavior.
 */
import { el, injectUiStyles } from './kit';
import { BindingScreen, InputService, KeyBinding, keyDisplay } from './input';

export class CheatSheet {
  private overlay: HTMLElement;
  private sheet: HTMLElement;
  visible = false;

  constructor(uiRoot: HTMLElement, private readonly input: InputService) {
    injectUiStyles();
    this.overlay = el('div', 'k-overlay', uiRoot);
    this.overlay.style.display = 'none';
    this.overlay.onclick = (e) => {
      if (e.target === this.overlay) this.hide();
    };
    this.sheet = el('div', 'k-sheet', this.overlay);
  }

  toggle(screen: BindingScreen): void {
    if (this.visible) this.hide();
    else this.show(screen);
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
  }

  show(screen: BindingScreen): void {
    this.visible = true;
    this.overlay.style.display = '';
    this.render(screen);
  }

  private render(screen: BindingScreen): void {
    this.sheet.innerHTML = '';
    el('h2', '', this.sheet, screen === 'flight' ? 'FLIGHT CONTROLS' : 'WORKSHOP CONTROLS');
    const groups = new Map<string, KeyBinding[]>();
    for (const b of this.input.list(screen)) {
      const list = groups.get(b.group) ?? [];
      list.push(b);
      groups.set(b.group, list);
    }
    const wrap = el('div', 'k-sheet-groups', this.sheet);
    for (const [group, bindings] of groups) {
      const box = el('div', 'k-sheet-group', wrap);
      el('h3', '', box, group);
      for (const b of bindings) {
        const row = el('div', 'k-key-row', box);
        el('span', 'k-key', row, keyDisplay(b));
        el('span', 'k-key-label', row, b.label);
      }
    }
    el('div', 'k-sheet-hint', this.sheet, 'Press ? or Esc to close · click outside to dismiss');
  }
}
