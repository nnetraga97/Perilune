/**
 * Instrument windows: draggable, collapsible floating panels with a top-bar
 * launcher (KSP AppLauncher pattern). Position, collapsed state, and open
 * state persist in the local profile store, not the game save.
 *
 * Consumers (KER-style readouts, alarms, planners — workstreams 2+) register
 * a definition; the manager owns lifecycle, z-order, and screen filtering.
 */
import { el, injectUiStyles } from './kit';
import { iconButton, type UtilityIcon } from './icons';
import { ProfileStore } from './profileStore';

export type WindowScreen = 'flight' | 'editor' | 'menu' | 'any';

export interface WindowDef {
  id: string;
  title: string;
  launcherIcon: UtilityIcon;
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
  width?: number;
  height?: number;
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
    this.root.dataset.windowId = def.id;
    this.root.style.display = 'none';
    const bar = el('div', 'k-window-bar', this.root);
    el('span', 'k-window-title', bar, def.title);
    const collapseBtn = el('button', 'k-window-btn', bar, state.collapsed ? '▸' : '▾');
    collapseBtn.title = 'Collapse';
    const closeBtn = el('button', 'k-window-btn', bar, '×');
    closeBtn.title = 'Close';
    this.content = el('div', 'k-window-content', this.root);
    const resizeHandle = el('div', 'k-window-resize-handle', this.root);
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'Resize window');
    resizeHandle.tabIndex = 0;
    if (state.open) {
      this.built = true;
      def.build(this.content);
    }
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

    const resizeBy = (dx: number, dy: number, startWidth: number, startHeight: number) => {
      const maxWidth = Math.max(240, window.innerWidth - 16);
      const maxHeight = Math.max(180, window.innerHeight - 16);
      this.state.width = Math.max(190, Math.min(maxWidth, startWidth + dx));
      this.state.height = Math.max(120, Math.min(maxHeight, startHeight + dy));
      this.applyState();
    };
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (window.matchMedia('(max-width: 820px), (pointer: coarse)').matches) return;
      event.preventDefault();
      event.stopPropagation();
      onFocus(this);
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = this.root.offsetWidth;
      const startHeight = this.root.offsetHeight;
      resizeHandle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        resizeBy(moveEvent.clientX - startX, moveEvent.clientY - startY, startWidth, startHeight);
      };
      const up = () => {
        resizeHandle.removeEventListener('pointermove', move);
        resizeHandle.removeEventListener('pointerup', up);
        resizeHandle.removeEventListener('pointercancel', up);
        onState();
      };
      resizeHandle.addEventListener('pointermove', move);
      resizeHandle.addEventListener('pointerup', up);
      resizeHandle.addEventListener('pointercancel', up);
    });
    resizeHandle.addEventListener('keydown', (event) => {
      const direction = event.shiftKey ? 24 : 8;
      const dx = event.key === 'ArrowRight' ? direction : event.key === 'ArrowLeft' ? -direction : 0;
      const dy = event.key === 'ArrowDown' ? direction : event.key === 'ArrowUp' ? -direction : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      resizeBy(dx, dy, this.root.offsetWidth, this.root.offsetHeight);
      onState();
    });
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
    this.root.style.width = this.state.width ? `${this.state.width}px` : '';
    this.root.style.height = this.state.height ? `${this.state.height}px` : '';
    this.content.style.display = this.state.collapsed ? 'none' : '';
    this.root.classList.toggle('collapsed', this.state.collapsed);
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

    const btn = iconButton(
      this.launcher,
      def.launcherIcon,
      def.buttonLabel ?? def.title,
      () => win.setOpen(!win.open),
      'k-launcher-btn',
    );
    this.buttons.set(def.id, btn);
    this.applyScreen();
  }

  /** Add an action button to the launcher (e.g. the keyboard cheat sheet). */
  addAction(icon: UtilityIcon, label: string, fn: () => void): void {
    iconButton(this.launcher, icon, label, fn, 'k-launcher-btn');
  }

  setLauncherHost(host: HTMLElement | null): void {
    (host ?? this.uiRoot).appendChild(this.launcher);
    this.launcher.classList.toggle('k-launcher-floating', host === null);
  }

  setScreen(screen: 'flight' | 'editor' | 'menu'): void {
    this.screen = screen;
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

  close(id: string): void {
    this.windows.get(id)?.setOpen(false);
  }

  private applyScreen(): void {
    for (const win of this.windows.values()) {
      const visible = win.def.screen === 'any' || win.def.screen === this.screen;
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
