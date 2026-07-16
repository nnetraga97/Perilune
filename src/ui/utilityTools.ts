import type { GameState } from '../sim/state';
import {
  EXPERIMENT_INDEX,
  EXPERIMENTS,
  experimentCap,
  scienceBiomesForSituation,
} from '../content/science';
import type { ConflictChoice, UnifiedSaveSlot } from '../cloud/types';
import { el } from './kit';
import { type KeyBinding, InputService, keyDisplay } from './input';
import type { ProfileStore } from './profileStore';
import type { WindowManager } from './window';
import {
  acceptContract,
  CONTRACTS,
  purchaseUpgrade,
  REPEATABLE_UPGRADES,
  settleContracts,
  TECHNOLOGIES,
  unlockTechnology,
  upgradeCost,
} from '../sim/campaign';
import {
  aboardScienceValue,
  decodeScienceKey,
  deliveredScience,
  encodeScienceKey,
  type LedgerEntry,
  type ScienceKey,
} from '../sim/science';

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
  telemetryEnabled: boolean;
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
  telemetryEnabled: true,
};

export interface UtilityCallbacks {
  onSave(slot: string, label: string): Promise<boolean>;
  onLoad(slot: string): Promise<void>;
  onListSaves(): Promise<UnifiedSaveSlot[]>;
  onRefreshSaves(): Promise<void>;
  onDeleteSave(slot: string): Promise<boolean>;
  onResolveConflict(slot: string, choice: ConflictChoice): Promise<boolean>;
  onSavesChanged(listener: () => void): () => void;
  onSettings(settings: UiSettings): void;
  onTelemetry(enabled: boolean): void;
  onCampaignChanged(): void;
}

export class UtilityTools {
  private settings: UiSettings;
  private scienceEl: HTMLElement | null = null;
  private savesEl: HTMLElement | null = null;
  private logEl: HTMLElement | null = null;
  private settingsEl: HTMLElement | null = null;
  private programEl: HTMLElement | null = null;
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
    callbacks.onTelemetry(this.settings.telemetryEnabled);
    callbacks.onSavesChanged(() => { if (this.savesEl) void this.renderSaves(); });

    windows.register({
      id: 'program-control', title: 'PROGRAM CONTROL', launcherIcon: 'program', buttonLabel: 'Program Control', screen: 'any',
      defaultPos: { x: 36, y: 82 },
      build: (content) => { this.programEl = content; this.renderProgram(); },
      update: () => this.renderProgram(),
    });
    windows.register({
      id: 'science-archive', title: 'SCIENCE ARCHIVE', launcherIcon: 'science', buttonLabel: 'Science', screen: 'any',
      defaultPos: { x: 36, y: 110 },
      build: (content) => { this.scienceEl = content; this.renderScience(); },
      update: () => this.renderScience(),
    });
    windows.register({
      id: 'save-browser', title: 'SAVE & LOAD', launcherIcon: 'save', buttonLabel: 'Saves', screen: 'any',
      defaultPos: { x: 310, y: 100 },
      build: (content) => { this.savesEl = content; void this.renderSaves(); },
    });
    windows.register({
      id: 'notification-log', title: 'MISSION LOG', launcherIcon: 'log', buttonLabel: 'Log', screen: 'flight',
      defaultPos: { x: 36, y: 330 },
      build: (content) => { this.logEl = content; this.renderLog(); },
      update: () => this.renderLog(),
    });
    windows.register({
      id: 'settings', title: 'SETTINGS', launcherIcon: 'settings', buttonLabel: 'Settings', screen: 'any',
      defaultPos: { x: 650, y: 90 },
      build: (content) => { this.settingsEl = content; this.renderSettings(); },
    });
  }

  openSaves(): void {
    this.windows.toggle('save-browser');
    void this.callbacks.onRefreshSaves().finally(() => this.renderSaves());
  }

  openSettings(): void {
    this.windows.toggle('settings');
  }

  private renderProgram(): void {
    if (!this.programEl) return;
    const game = this.game();
    const campaign = game.campaign;
    this.programEl.replaceChildren();

    const modeName = campaign.mode === 'program'
      ? 'SPACE PROGRAM'
      : campaign.mode === 'exploration'
        ? 'EXPLORATION'
        : 'SANDBOX';
    const hero = el('section', 'program-hero', this.programEl);
    el('div', 'program-kicker', hero, modeName);
    el(
      'div',
      'program-balance',
      hero,
      campaign.mode === 'program'
        ? `${campaign.funds.toLocaleString()} FUNDS · ${campaign.reputation} REPUTATION · ${game.sciencePoints} SCIENCE`
        : `${game.sciencePoints} SCIENCE AVAILABLE`,
    );
    el(
      'div',
      'utility-muted',
      hero,
      campaign.mode === 'sandbox'
        ? 'All technology is open. Funding and contracts are disabled.'
        : campaign.mode === 'exploration'
          ? 'Recover experiments, then invest science to expand the Workshop.'
          : 'Commit funds at launch, recover hardware for a partial refund, and fulfill accepted contracts.',
    );

    if (campaign.mode !== 'sandbox') {
      el('div', 'program-section-heading', this.programEl, 'TECHNOLOGY PATH');
      const techGrid = el('div', 'program-tech-grid', this.programEl);
      for (const technology of TECHNOLOGIES) {
        const unlocked = campaign.unlockedTech.includes(technology.id);
        const prerequisiteMet = !technology.requires || campaign.unlockedTech.includes(technology.requires);
        const card = el('article', `program-card${unlocked ? ' is-complete' : ''}`, techGrid);
        el('div', 'program-card-state', card, unlocked ? 'DEPLOYED' : `${technology.scienceCost} SCIENCE`);
        el('strong', '', card, technology.name);
        el('p', '', card, technology.brief);
        if (!unlocked) {
          const unlock = el('button', 'hud-btn program-action', card, prerequisiteMet ? 'Unlock' : 'Prerequisite required') as HTMLButtonElement;
          unlock.disabled = !prerequisiteMet || game.sciencePoints < technology.scienceCost;
          unlock.onclick = () => {
            const result = unlockTechnology(campaign, game.sciencePoints, technology.id);
            if (!result.ok) return;
            game.sciencePoints = result.sciencePoints;
            this.callbacks.onCampaignChanged();
            this.renderProgram();
          };
        }
      }

      el('div', 'program-section-heading', this.programEl, 'REPEATABLE RESEARCH');
      const upgradeGrid = el('div', 'program-tech-grid', this.programEl);
      for (const upgrade of REPEATABLE_UPGRADES) {
        const level = campaign.upgradeLevels[upgrade.id] ?? 0;
        const cost = upgradeCost(upgrade, level);
        const prerequisiteMet = campaign.unlockedTech.includes(upgrade.requires);
        const card = el('article', 'program-card', upgradeGrid);
        el('div', 'program-card-state', card, `LEVEL ${level} · ${cost} SCIENCE`);
        el('strong', '', card, upgrade.name);
        el('p', '', card, upgrade.brief);
        const buy = el(
          'button',
          'hud-btn program-action',
          card,
          prerequisiteMet ? 'Research next level' : 'Precision Science required',
        ) as HTMLButtonElement;
        buy.disabled = !prerequisiteMet || game.sciencePoints < cost;
        buy.onclick = () => {
          const result = purchaseUpgrade(campaign, game.sciencePoints, upgrade.id);
          if (!result.ok) return;
          game.sciencePoints = result.sciencePoints;
          this.callbacks.onCampaignChanged();
          this.renderProgram();
        };
      }
    }

    if (campaign.mode === 'program') {
      el('div', 'program-section-heading', this.programEl, 'CONTRACT BOARD');
      const board = el('div', 'program-contracts', this.programEl);
      for (const contract of CONTRACTS) {
        const completed = campaign.completedContracts.includes(contract.id);
        const active = campaign.activeContracts.includes(contract.id);
        const card = el('article', `program-card program-contract${completed ? ' is-complete' : active ? ' is-active' : ''}`, board);
        el('div', 'program-card-state', card, completed ? 'FULFILLED' : active ? 'ACTIVE' : 'AVAILABLE');
        el('strong', '', card, contract.name);
        el('p', '', card, contract.brief);
        el('div', 'program-reward', card, `+${contract.rewardFunds.toLocaleString()} funds · +${contract.rewardReputation} reputation`);
        if (!completed && !active) {
          const accept = el('button', 'hud-btn program-action', card, 'Accept contract') as HTMLButtonElement;
          accept.disabled = campaign.activeContracts.length >= 3;
          accept.onclick = () => {
            const result = acceptContract(campaign, contract.id);
            if (!result.ok) return;
            settleContracts(campaign, game.flags);
            this.callbacks.onCampaignChanged();
            this.renderProgram();
          };
        }
      }
    }
  }

  private renderScience(): void {
    if (!this.scienceEl) return;
    const game = this.game();
    const stored = game.vessels.flatMap((vessel) => [...vessel.runtime.scienceBuffer.entries()].map(([keyId, result]) => ({
      keyId, result, vessel: vessel.runtime.name,
    })));
    const ledgerSignature = [...game.scienceLedger]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${key}:${entry.cap}:${entry.deliveredByTransmit}:${entry.deliveredByRecovery}`)
      .join('|');
    const bufferSignature = stored
      .map(({ keyId, result, vessel }) => `${vessel}:${keyId}:${result.heldValue}:${result.transmittedFromThis}:${result.transmitTarget}`)
      .sort()
      .join('|');
    const signature = `${game.sciencePoints}:${ledgerSignature}:${bufferSignature}`;
    if (signature === this.lastScienceSignature) return;
    this.lastScienceSignature = signature;
    this.scienceEl.replaceChildren();
    let transmitted = 0;
    let recovered = 0;
    for (const entry of game.scienceLedger.values()) {
      transmitted += entry.deliveredByTransmit;
      recovered += entry.deliveredByRecovery;
    }
    el(
      'div',
      'utility-total',
      this.scienceEl,
      `${game.sciencePoints} AVAILABLE · ${transmitted} TRANSMITTED · ${recovered} RECOVERED · ${aboardScienceValue(game)} ABOARD`,
    );

    if (stored.length) {
      const aboard = el('section', 'utility-section', this.scienceEl);
      el('div', 'utility-heading', aboard, 'RESULTS ABOARD');
      for (const storedResult of stored) {
        const key = decodeScienceKey(storedResult.keyId);
        const experiment = key ? EXPERIMENT_INDEX.get(key.experimentId) : null;
        const body = key ? game.universe.bodies.get(key.bodyId) : null;
        const biome = body?.def.biomes?.find((candidate) => candidate.id === key?.biomeId);
        const deliverable = Math.max(0, storedResult.result.heldValue - storedResult.result.transmittedFromThis);
        const deliveryLabel = storedResult.result.transmitTarget === 0
          ? `${deliverable} recover only`
          : `${deliverable} remaining`;
        const card = el('div', 'utility-science-card', aboard);
        el('strong', '', card, experiment?.name ?? storedResult.keyId);
        el(
          'span',
          '',
          card,
          `${deliveryLabel} · ${key?.situation ?? 'unknown'} · ${body?.name ?? key?.bodyId ?? 'unknown'} / ${biome?.name ?? key?.biomeId ?? 'unknown'} · ${storedResult.vessel}`,
        );
        if (experiment) el('em', '', card, experiment.blurb);
      }
    }

    const groups = new Map<string, Array<{ keyId: string; key: ScienceKey; entry: LedgerEntry }>>();
    const listedKeys = new Set<string>();
    for (const body of game.universe.bodies.values()) {
      if (body.def.isStar) continue;
      for (const experiment of EXPERIMENTS) {
        if (experiment.needsAtmosphere && !body.hasAtmosphere()) continue;
        for (const situation of experiment.validSituations) {
          for (const biome of scienceBiomesForSituation(body.def, situation)) {
            const key: ScienceKey = {
              experimentId: experiment.id,
              bodyId: body.id,
              biomeId: biome.id,
              situation,
            };
            const keyId = encodeScienceKey(key);
            const groupId = `${key.bodyId}\u0000${key.biomeId}\u0000${key.situation}`;
            const entry = game.scienceLedger.get(keyId) ?? {
              cap: experimentCap(experiment, body.def.scienceValue, biome.scienceMultiplier),
              deliveredByTransmit: 0,
              deliveredByRecovery: 0,
            };
            const group = groups.get(groupId) ?? [];
            group.push({ keyId, key, entry });
            groups.set(groupId, group);
            listedKeys.add(keyId);
          }
        }
      }
    }
    // Preserve migrated or previously-authored sites even if current content no longer enumerates them.
    for (const [keyId, entry] of game.scienceLedger) {
      if (listedKeys.has(keyId)) continue;
      const key = decodeScienceKey(keyId);
      if (!key) continue;
      const groupId = `${key.bodyId}\u0000${key.biomeId}\u0000${key.situation}`;
      const group = groups.get(groupId) ?? [];
      group.push({ keyId, key, entry });
      groups.set(groupId, group);
    }
    for (const [groupId, results] of groups) {
      const [bodyId, biomeId, situation] = groupId.split('\u0000');
      const body = game.universe.bodies.get(bodyId);
      const biome = body?.def.biomes?.find((candidate) => candidate.id === biomeId);
      const section = el('section', 'utility-section', this.scienceEl);
      el('div', 'utility-heading', section, `${body?.name ?? bodyId} · ${biome?.name ?? biomeId} · ${situation}`);
      for (const result of results.sort((a, b) => a.key.experimentId.localeCompare(b.key.experimentId))) {
        const experiment = EXPERIMENT_INDEX.get(result.key.experimentId);
        const remaining = Math.max(0, result.entry.cap - deliveredScience(result.entry));
        el(
          'div',
          'utility-row',
          section,
          `${experiment?.name ?? result.key.experimentId} · T ${result.entry.deliveredByTransmit} · R ${result.entry.deliveredByRecovery} · ${remaining} remaining`,
        );
      }
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
      const existing = (await this.callbacks.onListSaves()).some((candidate) => candidate.slot === slot);
      if (existing && !window.confirm(`Overwrite save “${label}”?`)) return;
      if (await this.callbacks.onSave(slot, label)) await this.renderSaves();
    };
    const slots = await this.callbacks.onListSaves();
    if (!slots.length) el('div', 'mission-empty', content, 'No saves yet');
    for (const meta of slots) this.renderSaveRow(content, meta);
  }

  private renderSaveRow(parent: HTMLElement, meta: UnifiedSaveSlot): void {
    const row = el('div', 'utility-save', parent);
    const copy = el('div', 'utility-save-copy', row);
    el('div', 'utility-heading', copy, meta.slot === 'auto' ? 'AUTOSAVE' : meta.label);
    el('span', `utility-sync utility-sync-${meta.state}`, copy, meta.state.toUpperCase());
    const details = meta.time === null || meta.vesselCount === null
      ? `${new Date(meta.createdAt).toLocaleString()} · available from cloud`
      : `${new Date(meta.createdAt).toLocaleString()} · UT ${meta.time.toFixed(0)} s · ${meta.vesselCount} vessel${meta.vesselCount === 1 ? '' : 's'}${meta.activeVesselName ? ` · ${meta.activeVesselName}` : ''}`;
    el('div', 'utility-muted', copy, details);
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
    if (meta.state === 'conflict') {
      for (const [choice, label] of [
        ['keep-local', 'Keep local'], ['keep-cloud', 'Keep cloud'], ['keep-both', 'Keep both'],
      ] as Array<[ConflictChoice, string]>) {
        const resolve = el('button', 'hud-btn', actions, label);
        resolve.onclick = async () => {
          if (await this.callbacks.onResolveConflict(meta.slot, choice)) await this.renderSaves();
        };
      }
    }
    const remove = el('button', 'hud-btn', actions, 'Delete');
    remove.onclick = async () => {
      if (!window.confirm(`Delete “${meta.label}” and its backups?`)) return;
      if (await this.callbacks.onDeleteSave(meta.slot)) await this.renderSaves();
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
    this.addToggle('Share anonymous diagnostics and usage', 'telemetryEnabled');

    el('div', 'mission-section-title', this.settingsEl, 'KEYBINDINGS · CLICK A KEY TO REMAP');
    const bindings = el('div', 'utility-bindings', this.settingsEl);
    for (const binding of this.input.remappable()) this.addBinding(bindings, binding);
    const reset = el('button', 'hud-btn utility-reset', this.settingsEl, 'Reset keybindings');
    reset.onclick = () => { this.input.resetRemaps(); this.renderSettings(); };
  }

  private commitSettings(): void {
    this.store.set('settings', this.settings);
    this.callbacks.onSettings(this.settings);
    this.callbacks.onTelemetry(this.settings.telemetryEnabled);
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

  private addToggle<K extends 'reducedMotion' | 'invertX' | 'invertY' | 'cameraSmoothing' | 'simplifiedTerms' | 'telemetryEnabled'>(label: string, key: K): void {
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
