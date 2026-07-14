import type { GameState } from '../sim/state';
import { EXPERIMENTS, experimentValue, type ScienceSituation } from '../content/science';
import { deleteSave, listSaves, type SaveSlotMeta } from '../save/persistence';
import { el } from './kit';
import { type KeyBinding, InputService, keyDisplay } from './input';
import type { ProfileStore } from './profileStore';
import type { WindowManager } from './window';

export interface UiSettings {
  uiScale: number;
  accent: 'cyan' | 'amber' | 'violet';
  reducedMotion: boolean;
  dragSensitivity: number;
  invertX: boolean;
  invertY: boolean;
  fov: number;
  cameraSmoothing: boolean;
  simplifiedTerms: boolean;
}

const DEFAULT_SETTINGS: UiSettings = {
  uiScale: 1,
  accent: 'cyan',
  reducedMotion: false,
  dragSensitivity: 1,
  invertX: false,
  invertY: false,
  fov: 55,
  cameraSmoothing: true,
  simplifiedTerms: false,
};

export interface UtilityCallbacks {
  onSave(slot: string, label: string): Promise<boolean>;
  onLoad(slot: string): Promise<void>;
  onSettings(settings: UiSettings): void;
}

const SITUATIONS: readonly ScienceSituation[] = [
  'surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high',
];

function parseScienceKey(key: string): { experimentId: string; bodyId: string; situation: ScienceSituation } | null {
  const at = key.indexOf('@');
  if (at < 1) return null;
  for (const situation of SITUATIONS) {
    const suffix = `-${situation}`;
    if (key.endsWith(suffix)) {
      return { experimentId: key.slice(0, at), bodyId: key.slice(at + 1, -suffix.length), situation };
    }
  }
  return null;
}

export class UtilityTools {
  private settings: UiSettings;
  private scienceEl: HTMLElement | null = null;
  private savesEl: HTMLElement | null = null;
  private logEl: HTMLElement | null = null;
  private settingsEl: HTMLElement | null = null;
  private lastScienceSignature = '';
  private lastLogSignature = '';

  constructor(
    private readonly windows: WindowManager,
    private readonly store: ProfileStore,
    private readonly input: InputService,
    private readonly game: () => GameState,
    private readonly callbacks: UtilityCallbacks,
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...store.get<Partial<UiSettings>>('settings', {}) };
    const remaps = store.get<Record<string, { code: string; shift: boolean; alt: boolean; ctrl: boolean }>>('keybindings', {});
    input.configureRemaps(remaps, (next) => store.set('keybindings', next));
    callbacks.onSettings(this.settings);

    windows.register({
      id: 'science-archive', title: 'SCIENCE ARCHIVE', buttonLabel: 'Science', screen: 'any',
      defaultPos: { x: 36, y: 110 },
      build: (content) => { this.scienceEl = content; this.renderScience(); },
      update: () => this.renderScience(),
    });
    windows.register({
      id: 'save-browser', title: 'SAVE & LOAD', buttonLabel: 'Saves', screen: 'any',
      defaultPos: { x: 310, y: 100 },
      build: (content) => { this.savesEl = content; void this.renderSaves(); },
    });
    windows.register({
      id: 'notification-log', title: 'MISSION LOG', buttonLabel: 'Log', screen: 'flight',
      defaultPos: { x: 36, y: 330 },
      build: (content) => { this.logEl = content; this.renderLog(); },
      update: () => this.renderLog(),
    });
    windows.register({
      id: 'settings', title: 'SETTINGS', buttonLabel: 'Settings', screen: 'any',
      defaultPos: { x: 650, y: 90 },
      build: (content) => { this.settingsEl = content; this.renderSettings(); },
    });
  }

  openSaves(): void {
    this.windows.toggle('save-browser');
    void this.renderSaves();
  }

  openSettings(): void {
    this.windows.toggle('settings');
  }

  private renderScience(): void {
    if (!this.scienceEl) return;
    const game = this.game();
    const stored = game.vessels.flatMap((vessel) => [...vessel.runtime.scienceData.entries()].map(([key, points]) => ({
      key, points, vessel: vessel.runtime.name,
    })));
    const signature = `${game.sciencePoints}:${[...game.completedExperiments].sort().join('|')}:${stored.length}`;
    if (signature === this.lastScienceSignature) return;
    this.lastScienceSignature = signature;
    this.scienceEl.replaceChildren();
    el('div', 'utility-total', this.scienceEl, `${game.sciencePoints} SCIENCE RECOVERED · ${stored.length} RESULTS ABOARD`);

    if (stored.length) {
      const aboard = el('section', 'utility-section', this.scienceEl);
      el('div', 'utility-heading', aboard, 'RESULTS AWAITING RECOVERY');
      for (const result of stored) {
        const parsed = parseScienceKey(result.key);
        const experiment = parsed ? EXPERIMENTS.find((candidate) => candidate.id === parsed.experimentId) : null;
        const body = parsed ? game.universe.bodies.get(parsed.bodyId) : null;
        const card = el('div', 'utility-science-card', aboard);
        el('strong', '', card, experiment?.name ?? result.key);
        el('span', '', card, `+${result.points} · ${parsed?.situation ?? 'unknown'} at ${body?.name ?? parsed?.bodyId ?? 'unknown'} · aboard ${result.vessel}`);
        if (experiment) el('em', '', card, experiment.blurb);
      }
    }

    const completed = [...game.completedExperiments].map(parseScienceKey).filter((item): item is NonNullable<typeof item> => item !== null);
    for (const experiment of EXPERIMENTS) {
      const section = el('section', 'utility-section', this.scienceEl);
      const done = completed.filter((item) => item.experimentId === experiment.id);
      el('div', 'utility-heading', section, `${experiment.name} · ${done.length} recovered`);
      el('div', 'utility-muted', section, experiment.blurb);
      for (const item of done.slice(-8)) {
        const body = game.universe.bodies.get(item.bodyId);
        const points = body ? experimentValue(experiment, body.def.scienceValue) : experiment.baseValue;
        el('div', 'utility-row', section, `${body?.name ?? item.bodyId} · ${item.situation}  +${points}`);
      }
      const remaining = experiment.validSituations.filter((situation) => !done.some((item) => item.situation === situation));
      el('div', 'utility-remaining', section, remaining.length ? `Still available: ${remaining.join(', ')}` : 'All situation types recovered');
    }
  }

  private async renderSaves(): Promise<void> {
    if (!this.savesEl) return;
    const content = this.savesEl;
    content.replaceChildren();
    const create = el('div', 'utility-create', content);
    const name = document.createElement('input');
    name.className = 'k-input';
    name.placeholder = 'Named save slot';
    create.appendChild(name);
    const save = el('button', 'hud-btn', create, 'Save now');
    save.onclick = async () => {
      const label = name.value.trim() || `Mission ${new Date().toLocaleString()}`;
      const slot = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `save-${Date.now()}`;
      const existing = (await listSaves()).some((candidate) => candidate.slot === slot);
      if (existing && !window.confirm(`Overwrite save “${label}”?`)) return;
      if (await this.callbacks.onSave(slot, label)) await this.renderSaves();
    };
    const slots = await listSaves();
    if (!slots.length) el('div', 'mission-empty', content, 'No saves yet');
    for (const meta of slots) this.renderSaveRow(content, meta);
  }

  private renderSaveRow(parent: HTMLElement, meta: SaveSlotMeta): void {
    const row = el('div', 'utility-save', parent);
    const copy = el('div', 'utility-save-copy', row);
    el('div', 'utility-heading', copy, meta.slot === 'auto' ? 'AUTOSAVE' : meta.label);
    el('div', 'utility-muted', copy,
      `${new Date(meta.createdAt).toLocaleString()} · UT ${meta.time.toFixed(0)} s · ${meta.vesselCount} vessel${meta.vesselCount === 1 ? '' : 's'}${meta.activeVesselName ? ` · ${meta.activeVesselName}` : ''}`);
    const actions = el('div', 'utility-actions', row);
    const load = el('button', 'hud-btn', actions, 'Load');
    load.onclick = () => void this.callbacks.onLoad(meta.slot);
    const overwrite = el('button', 'hud-btn', actions, 'Overwrite');
    overwrite.onclick = async () => {
      if (window.confirm(`Overwrite “${meta.label}” with the current mission?`)) {
        await this.callbacks.onSave(meta.slot, meta.label);
        await this.renderSaves();
      }
    };
    const remove = el('button', 'hud-btn', actions, 'Delete');
    remove.onclick = async () => {
      if (!window.confirm(`Delete “${meta.label}” and its backups?`)) return;
      await deleteSave(meta.slot);
      await this.renderSaves();
    };
  }

  private renderLog(): void {
    if (!this.logEl) return;
    const events = this.game().vessels.flatMap((vessel) => vessel.runtime.events.map((event) => ({ ...event, vessel: vessel.runtime.name })))
      .sort((a, b) => b.time - a.time);
    const signature = events.map((event) => `${event.time}:${event.text}`).join('|');
    if (signature === this.lastLogSignature) return;
    this.lastLogSignature = signature;
    this.logEl.replaceChildren();
    if (!events.length) el('div', 'mission-empty', this.logEl, 'No mission events yet');
    for (const event of events.slice(0, 100)) {
      const row = el('div', `utility-log ${event.severity}`, this.logEl);
      el('span', 'utility-time', row, `UT ${event.time.toFixed(0)}`);
      el('span', '', row, `${event.vessel}: ${event.text}`);
    }
  }

  private renderSettings(): void {
    if (!this.settingsEl) return;
    this.settingsEl.replaceChildren();
    this.addRange('UI scale', 'uiScale', 0.8, 1.4, 0.05);
    this.addSelect('Accent palette', 'accent', [
      ['cyan', 'Cyan'], ['amber', 'Amber'], ['violet', 'Violet'],
    ]);
    this.addToggle('Reduced motion', 'reducedMotion');
    this.addRange('Camera drag', 'dragSensitivity', 0.4, 2, 0.1);
    this.addToggle('Invert camera X', 'invertX');
    this.addToggle('Invert camera Y', 'invertY');
    this.addRange('Camera FOV', 'fov', 35, 85, 1);
    this.addToggle('Camera smoothing', 'cameraSmoothing');
    this.addToggle('Plain-language orbit labels', 'simplifiedTerms');

    el('div', 'mission-section-title', this.settingsEl, 'KEYBINDINGS · CLICK A KEY TO REMAP');
    const bindings = el('div', 'utility-bindings', this.settingsEl);
    for (const binding of this.input.remappable()) this.addBinding(bindings, binding);
    const reset = el('button', 'hud-btn utility-reset', this.settingsEl, 'Reset keybindings');
    reset.onclick = () => { this.input.resetRemaps(); this.renderSettings(); };
  }

  private commitSettings(): void {
    this.store.set('settings', this.settings);
    this.callbacks.onSettings(this.settings);
  }

  private addRange<K extends 'uiScale' | 'dragSensitivity' | 'fov'>(label: string, key: K, min: number, max: number, step: number): void {
    const row = el('label', 'utility-setting', this.settingsEl!);
    el('span', '', row, label);
    const value = el('span', 'utility-setting-value', row, String(this.settings[key]));
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(this.settings[key]);
    input.oninput = () => { this.settings[key] = Number(input.value); value.textContent = input.value; this.commitSettings(); };
    row.appendChild(input);
  }

  private addToggle<K extends 'reducedMotion' | 'invertX' | 'invertY' | 'cameraSmoothing' | 'simplifiedTerms'>(label: string, key: K): void {
    const row = el('label', 'utility-setting', this.settingsEl!);
    el('span', '', row, label);
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = this.settings[key];
    input.onchange = () => { this.settings[key] = input.checked; this.commitSettings(); };
    row.appendChild(input);
  }

  private addSelect(label: string, key: 'accent', options: Array<[UiSettings['accent'], string]>): void {
    const row = el('label', 'utility-setting', this.settingsEl!);
    el('span', '', row, label);
    const select = document.createElement('select'); select.className = 'k-select';
    for (const [value, text] of options) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
    }
    select.value = this.settings[key];
    select.onchange = () => { this.settings[key] = select.value as UiSettings['accent']; this.commitSettings(); };
    row.appendChild(select);
  }

  private addBinding(parent: HTMLElement, binding: KeyBinding): void {
    const row = el('div', 'utility-binding', parent);
    el('span', '', row, binding.label);
    const button = el('button', 'hud-btn', row, keyDisplay(binding));
    button.onclick = () => {
      button.textContent = 'Press a key…';
      const capture = (event: KeyboardEvent) => {
        event.preventDefault(); event.stopPropagation();
        this.input.remap(binding, event);
        window.removeEventListener('keydown', capture, true);
        this.renderSettings();
      };
      window.addEventListener('keydown', capture, true);
    };
  }
}
