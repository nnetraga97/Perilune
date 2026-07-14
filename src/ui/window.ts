/**
 * Instrument windows: draggable, collapsible floating panels with a top-bar
 * launcher (KSP AppLauncher pattern). Position, collapsed state, and open
 * state persist in the local profile store, not the game save.
 *
 * Consumers (KER-style readouts, alarms, planners — workstreams 2+) register
 * a definition; the manager owns lifecycle, z-order, and screen filtering.
 */
import { el, injectUiStyles } from './kit';
import { ProfileStore } from './profileStore';

export type WindowScreen = 'flight' | 'editor' | 'any';

export interface WindowDef {
  id: string;
  title: string;
  /** Launcher button text; defaults to title. */
  buttonLabel?: string;
  screen: WindowScreen;
  /** Build the window's content once, on first open. */
  build(content: HTMLElement): void;
  /** Optional per-frame refresh while the window is open. */
  update?(): void;
  defaultPos?: { x: number; y: number };
}

interface WindowState {
  x: number;
  y: number;
  collapsed: boolean;
  open: boolean;
}

/** Clamp a window position so its title bar stays reachable (pure; tested). */
export function clampWindowPos(
  x: number,
  y: number,
  width: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const minVisible = 48;
  return {
    x: Math.max(minVisible - width, Math.min(viewportW - minVisible, x)),
    y: Math.max(0, Math.min(viewportH - 28, y)),
  };
}

class UiWindow {
  readonly root: HTMLElement;
  readonly content: HTMLElement;
  private built = false;

  constructor(
    readonly def: WindowDef,
    private readonly parent: HTMLElement,
    private readonly state: WindowState,
    private readonly onState: () => void,
    private readonly onFocus: (w: UiWindow) => void,
  ) {
    this.root = el('div', 'k-window', parent);
    this.root.style.display = 'none';
    const bar = el('div', 'k-window-bar', this.root);
    el('span', 'k-window-title', bar, def.title);
    const collapseBtn = el('button', 'k-window-btn', bar, state.collapsed ? '▸' : '▾');
    collapseBtn.title = 'Collapse';
    const closeBtn = el('button', 'k-window-btn', bar, '×');
    closeBtn.title = 'Close';
    this.content = el('div', 'k-window-content', this.root);
    this.applyState();

    collapseBtn.onclick = () => {
      state.collapsed = !state.collapsed;
      collapseBtn.textContent = state.collapsed ? '▸' : '▾';
      this.applyState();
      onState();
    };
    closeBtn.onclick = () => this.setOpen(false);

    // Title-bar dragging.
    bar.addEventListener('pointerdown', (e) => {
      if (e.target === collapseBtn || e.target === closeBtn) return;
      onFocus(this);
      const startX = e.clientX - this.state.x;
      const startY = e.clientY - this.state.y;
      const move = (ev: PointerEvent) => {
        const p = clampWindowPos(
          ev.clientX - startX,
          ev.clientY - startY,
          this.root.offsetWidth,
          window.innerWidth,
          window.innerHeight,
        );
        this.state.x = p.x;
        this.state.y = p.y;
        this.applyState();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        onState();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
    this.root.addEventListener('pointerdown', () => onFocus(this));
  }

  get open(): boolean {
    return this.state.open;
  }

  setOpen(open: boolean): void {
    this.state.open = open;
    if (open && !this.built) {
      this.built = true;
      this.def.build(this.content);
    }
    this.applyVisibility();
    this.onState();
  }

  /** Show/hide for the current screen without touching the open preference. */
  setScreenVisible(visible: boolean): void {
    this.screenVisible = visible;
    this.applyVisibility();
  }
  private screenVisible = false;

  private applyVisibility(): void {
    this.root.style.display = this.state.open && this.screenVisible ? '' : 'none';
  }

  private applyState(): void {
    this.root.style.left = `${this.state.x}px`;
    this.root.style.top = `${this.state.y}px`;
    this.content.style.display = this.state.collapsed ? 'none' : '';
  }

  raise(z: number): void {
    this.root.style.zIndex = String(z);
  }
}

export class WindowManager {
  private readonly windows = new Map<string, UiWindow>();
  private readonly buttons = new Map<string, HTMLElement>();
  private readonly launcher: HTMLElement;
  private screen: WindowScreen = 'any';
  private zTop = 45;
  private nextDefaultY = 60;

  constructor(
    private readonly uiRoot: HTMLElement,
    private readonly store: ProfileStore,
  ) {
    injectUiStyles();
    this.launcher = el('div', 'k-launcher', uiRoot);
    this.launcher.style.display = 'none';
  }

  register(def: WindowDef): void {
    const fallback: WindowState = {
      x: def.defaultPos?.x ?? 250,
      y: def.defaultPos?.y ?? (this.nextDefaultY += 30),
      collapsed: false,
      open: false,
    };
    const state = { ...fallback, ...this.store.get<Partial<WindowState>>(`win.${def.id}`, {}) };
    const win = new UiWindow(
      def,
      this.uiRoot,
      state,
      () => {
        this.store.set(`win.${def.id}`, state);
        this.syncButtons();
      },
      (w) => w.raise(++this.zTop),
    );
    this.windows.set(def.id, win);

    const btn = el('button', 'hud-btn k-launcher-btn', this.launcher, def.buttonLabel ?? def.title);
    btn.title = def.title;
    btn.onclick = () => win.setOpen(!win.open);
    this.buttons.set(def.id, btn);
    this.applyScreen();
  }

  /** Add a plain action button to the launcher (e.g. the ? cheat sheet). */
  addAction(label: string, title: string, fn: () => void): void {
    const btn = el('button', 'hud-btn k-launcher-btn', this.launcher, label);
    btn.title = title;
    btn.onclick = fn;
  }

  setScreen(screen: 'flight' | 'editor' | 'menu'): void {
    this.screen = screen === 'menu' ? 'any' : screen;
    this.launcher.style.display = screen === 'menu' ? 'none' : '';
    this.applyScreen();
  }

  /** Per-frame: refresh open windows that asked for updates. */
  update(): void {
    for (const win of this.windows.values()) {
      if (win.open) win.def.update?.();
    }
  }

  toggle(id: string): void {
    const win = this.windows.get(id);
    if (win) win.setOpen(!win.open);
  }

  private applyScreen(): void {
    for (const win of this.windows.values()) {
      const visible =
        this.screen !== 'any' && (win.def.screen === 'any' || win.def.screen === this.screen);
      win.setScreenVisible(visible);
      const btn = this.buttons.get(win.def.id);
      if (btn) btn.style.display = visible ? '' : 'none';
    }
    this.syncButtons();
  }

  private syncButtons(): void {
    for (const [id, btn] of this.buttons) {
      btn.classList.toggle('active', this.windows.get(id)?.open ?? false);
    }
  }
}
