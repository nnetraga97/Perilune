import type { GameState } from '../sim/state';
import {
  EXPERIMENT_INDEX,
  EXPERIMENTS,
  experimentCap,
  scienceBiomesForSituation,
  type ScienceSituation,
} from '../content/science';
import { HOME_BODY_ID } from '../content/system';
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
  collectFraction,
  decodeScienceKey,
  deliveredScience,
  encodeScienceKey,
  sampleTransmitFraction,
  type LedgerEntry,
  type ScienceKey,
} from '../sim/science';
import { PARTS } from '../content/parts';
import { clientLog } from '../telemetry/log';

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

export type ScienceArchiveStatus = 'all' | 'unvisited' | 'in-progress' | 'complete' | 'aboard';
type ProgramView = 'tech' | 'research' | 'contracts';

export interface ScienceArchiveFilters {
  query: string;
  bodyId: string;
  experimentId: string;
  situation: string;
  status: ScienceArchiveStatus;
}

interface ScienceArchiveRecord {
  keyId: string;
  key: ScienceKey;
  bodyName: string;
  biomeName: string;
  experimentName: string;
  entry: LedgerEntry;
  status: Exclude<ScienceArchiveStatus, 'all' | 'aboard'>;
}

interface ScienceAboardRecord {
  keyId: string;
  key: ScienceKey | null;
  bodyName: string;
  biomeName: string;
  experimentName: string;
  vesselName: string;
  value: number;
  recoverOnly: boolean;
}

export function scienceArchiveStatus(entry: Readonly<LedgerEntry>): ScienceArchiveRecord['status'] {
  const delivered = deliveredScience(entry);
  if (delivered <= 0) return 'unvisited';
  return delivered >= entry.cap ? 'complete' : 'in-progress';
}

export function filterScienceArchiveRecords(
  records: readonly ScienceArchiveRecord[],
  filters: Readonly<ScienceArchiveFilters>,
): ScienceArchiveRecord[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return records.filter((record) => {
    if (filters.status === 'aboard') return false;
    if (filters.bodyId !== 'all' && record.key.bodyId !== filters.bodyId) return false;
    if (filters.experimentId !== 'all' && record.key.experimentId !== filters.experimentId) return false;
    if (filters.situation !== 'all' && record.key.situation !== filters.situation) return false;
    if (filters.status !== 'all' && record.status !== filters.status) return false;
    if (!query) return true;
    return `${record.bodyName} ${record.biomeName} ${record.experimentName} ${record.key.situation}`
      .toLocaleLowerCase()
      .includes(query);
  });
}

const TECH_NODE_WIDTH = 172;
const TECH_NODE_HEIGHT = 112;
const TECH_TREE_LAYOUT: Readonly<Record<string, { x: number; y: number }>> = {
  foundations: { x: 24, y: 188 },
  'orbital-engineering': { x: 234, y: 86 },
  'atmospheric-flight': { x: 234, y: 326 },
  'exploration-instruments': { x: 444, y: 28 },
  'deep-space-systems': { x: 444, y: 246 },
  'precision-science': { x: 654, y: 0 },
  'surface-operations': { x: 654, y: 158 },
  'crewed-expeditions': { x: 654, y: 326 },
  'planetary-industry': { x: 864, y: 158 },
};

function techConnectorPath(parentId: string, childId: string): string {
  const parent = TECH_TREE_LAYOUT[parentId];
  const child = TECH_TREE_LAYOUT[childId];
  if (!parent || !child) return '';
  const x1 = parent.x + TECH_NODE_WIDTH;
  const y1 = parent.y + TECH_NODE_HEIGHT / 2;
  const x2 = child.x;
  const y2 = child.y + TECH_NODE_HEIGHT / 2;
  const bend = Math.max(36, (x2 - x1) * 0.52);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export class UtilityTools {
  private settings: UiSettings;
  private scienceEl: HTMLElement | null = null;
  private savesEl: HTMLElement | null = null;
  private logEl: HTMLElement | null = null;
  private settingsEl: HTMLElement | null = null;
  private programEl: HTMLElement | null = null;
  private lastScienceSignature = '';
  private lastProgramSignature = '';
  private lastLogSignature = '';
  private scienceFilters: ScienceArchiveFilters = {
    query: '', bodyId: 'all', experimentId: 'all', situation: 'all', status: 'all',
  };
  private readonly scienceOpenBodies = new Set<string>([HOME_BODY_ID]);
  private programView: ProgramView = 'tech';

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
    if (campaign.mode !== 'program' && this.programView === 'contracts') this.programView = 'tech';
    const signature = JSON.stringify({
      view: this.programView,
      science: game.sciencePoints,
      mode: campaign.mode,
      funds: campaign.funds,
      reputation: campaign.reputation,
      tech: campaign.unlockedTech,
      upgrades: campaign.upgradeLevels,
      active: campaign.activeContracts,
      complete: campaign.completedContracts,
    });
    if (signature === this.lastProgramSignature) return;
    this.lastProgramSignature = signature;
    this.programEl.replaceChildren();
    this.programEl.classList.add('program-console');

    const modeName = campaign.mode === 'program'
      ? 'SPACE PROGRAM'
      : campaign.mode === 'exploration'
        ? 'EXPLORATION'
        : 'SANDBOX';
    const header = el('header', 'program-command-header', this.programEl);
    const identity = el('div', 'program-command-identity', header);
    el('div', 'program-kicker', identity, `${modeName} / RESEARCH DIRECTORATE`);
    el('strong', 'program-command-title', identity, 'Capability Network');
    const metrics = el('div', 'program-command-metrics', header);
    this.programMetric(metrics, 'SCIENCE', game.sciencePoints.toLocaleString(), 'spendable');
    if (campaign.mode === 'program') {
      this.programMetric(metrics, 'FUNDS', campaign.funds.toLocaleString(), 'available');
      this.programMetric(metrics, 'REPUTATION', campaign.reputation.toLocaleString(), 'standing');
    }
    this.programMetric(
      metrics,
      'DEPLOYED',
      `${campaign.unlockedTech.length}/${TECHNOLOGIES.length}`,
      'technologies',
    );

    const tabs = el('nav', 'program-tabs', this.programEl);
    tabs.setAttribute('aria-label', 'Program Control views');
    const views: Array<{ id: ProgramView; label: string }> = [
      { id: 'tech', label: 'Technology Tree' },
      { id: 'research', label: 'Repeatable Research' },
    ];
    if (campaign.mode === 'program') views.push({ id: 'contracts', label: 'Contracts' });
    for (const view of views) {
      const button = el('button', `program-tab${this.programView === view.id ? ' active' : ''}`, tabs, view.label);
      button.setAttribute('aria-pressed', `${this.programView === view.id}`);
      button.onclick = () => {
        this.programView = view.id;
        this.lastProgramSignature = '';
        this.renderProgram();
      };
    }

    const viewport = el('div', 'program-view', this.programEl);
    if (this.programView === 'tech') this.renderTechnologyTree(viewport, game);
    else if (this.programView === 'research') this.renderRepeatableResearch(viewport, game);
    else this.renderContracts(viewport, game);
  }

  private programMetric(parent: HTMLElement, label: string, value: string, note: string): void {
    const metric = el('div', 'program-command-metric', parent);
    el('span', '', metric, label);
    el('strong', '', metric, value);
    el('em', '', metric, note);
  }

  private renderTechnologyTree(parent: HTMLElement, game: GameState): void {
    const intro = el('div', 'tech-tree-intro', parent);
    const copy = el('div', '', intro);
    el('strong', '', copy, 'Technology branches unlock from left to right');
    el('span', '', copy, 'Deploy prerequisite nodes to expose new hardware families in the Workshop.');
    const legend = el('div', 'tech-tree-legend', intro);
    for (const [state, label] of [['deployed', 'Deployed'], ['available', 'Available'], ['locked', 'Locked']]) {
      el('span', `tech-legend-${state}`, legend, label);
    }

    const scroller = el('div', 'tech-tree-scroll', parent);
    scroller.tabIndex = 0;
    scroller.setAttribute('aria-label', 'Scrollable technology tree');
    const canvas = el('div', 'tech-tree-canvas', scroller);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tech-tree-links');
    svg.setAttribute('viewBox', '0 0 1060 470');
    svg.setAttribute('aria-hidden', 'true');
    canvas.appendChild(svg);
    for (const technology of TECHNOLOGIES) {
      if (!technology.requires) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', techConnectorPath(technology.requires, technology.id));
      const parentUnlocked = game.campaign.unlockedTech.includes(technology.requires);
      const unlocked = game.campaign.unlockedTech.includes(technology.id);
      path.setAttribute('class', unlocked ? 'deployed' : parentUnlocked ? 'available' : 'locked');
      svg.appendChild(path);
    }

    for (const technology of TECHNOLOGIES) {
      const position = TECH_TREE_LAYOUT[technology.id];
      if (!position) continue;
      const unlocked = game.campaign.unlockedTech.includes(technology.id);
      const prerequisiteMet = !technology.requires || game.campaign.unlockedTech.includes(technology.requires);
      const affordable = game.sciencePoints >= technology.scienceCost;
      const state = unlocked ? 'deployed' : prerequisiteMet ? 'available' : 'locked';
      const node = el('article', `tech-node ${state}`, canvas);
      node.style.left = `${position.x}px`;
      node.style.top = `${position.y}px`;
      node.dataset.techId = technology.id;
      node.title = technology.brief;
      el('div', 'tech-node-state', node, unlocked ? 'DEPLOYED' : prerequisiteMet ? 'READY TO RESEARCH' : 'PREREQUISITE LOCKED');
      el('strong', 'tech-node-name', node, technology.name);
      const parts = PARTS.filter((part) => part.tech === technology.id).length;
      el('div', 'tech-node-meta', node, `${parts} PART${parts === 1 ? '' : 'S'} · ${technology.scienceCost} SCI`);
      if (!unlocked) {
        const unlock = el(
          'button',
          'tech-node-action',
          node,
          prerequisiteMet ? (affordable ? 'Deploy node' : `Need ${technology.scienceCost - game.sciencePoints}`) : 'Locked',
        ) as HTMLButtonElement;
        unlock.disabled = !prerequisiteMet || !affordable || game.campaign.mode === 'sandbox';
        unlock.onclick = () => {
          const result = unlockTechnology(game.campaign, game.sciencePoints, technology.id);
          if (!result.ok) return;
          game.sciencePoints = result.sciencePoints;
          clientLog.info('tech.unlock', { technologyId: technology.id });
          this.callbacks.onCampaignChanged();
          this.lastProgramSignature = '';
          this.renderProgram();
        };
      } else {
        el('div', 'tech-node-deployed', node, 'Hardware online');
      }
    }
  }

  private renderRepeatableResearch(parent: HTMLElement, game: GameState): void {
    const heading = el('div', 'program-view-heading', parent);
    el('strong', '', heading, 'Continuous Research Programs');
    el('span', '', heading, 'Permanent levels affect future collections only; data already aboard keeps its original values.');
    const grid = el('div', 'research-program-grid', parent);
    for (const upgrade of REPEATABLE_UPGRADES) {
      const level = game.campaign.upgradeLevels[upgrade.id] ?? 0;
      const cost = upgradeCost(upgrade, level);
      const prerequisiteMet = game.campaign.unlockedTech.includes(upgrade.requires);
      const card = el('article', `research-program-card${prerequisiteMet ? '' : ' locked'}`, grid);
      const levelBadge = el('div', 'research-level', card);
      el('span', '', levelBadge, 'LEVEL');
      el('strong', '', levelBadge, `${level}`);
      const copy = el('div', 'research-copy', card);
      el('strong', '', copy, upgrade.name);
      el('p', '', copy, upgrade.brief);
      const effect = upgrade.id === 'field-methods'
        ? `${Math.round(collectFraction(level) * 100)}% of remaining site value captured`
        : `${Math.round(sampleTransmitFraction(0.25, level) * 100)}% transmission for spore-class samples`;
      el('div', 'research-effect', copy, effect);
      const footer = el('div', 'research-footer', card);
      el('span', '', footer, `NEXT LEVEL · ${cost} SCIENCE`);
      const buy = el(
        'button',
        'hud-btn research-buy',
        footer,
        prerequisiteMet ? 'Fund research' : 'Precision Science required',
      ) as HTMLButtonElement;
      buy.disabled = !prerequisiteMet || game.sciencePoints < cost || game.campaign.mode === 'sandbox';
      buy.onclick = () => {
        const result = purchaseUpgrade(game.campaign, game.sciencePoints, upgrade.id);
        if (!result.ok) return;
        game.sciencePoints = result.sciencePoints;
        this.callbacks.onCampaignChanged();
        this.lastProgramSignature = '';
        this.renderProgram();
      };
    }
  }

  private renderContracts(parent: HTMLElement, game: GameState): void {
    const heading = el('div', 'program-view-heading', parent);
    el('strong', '', heading, 'Contract Operations');
    el('span', '', heading, `${game.campaign.activeContracts.length}/3 active assignments`);
    const board = el('div', 'contract-operation-grid', parent);
    for (const contract of CONTRACTS) {
      const completed = game.campaign.completedContracts.includes(contract.id);
      const active = game.campaign.activeContracts.includes(contract.id);
      const card = el('article', `contract-operation-card${completed ? ' complete' : active ? ' active' : ''}`, board);
      el('div', 'contract-state', card, completed ? 'FULFILLED' : active ? 'ACTIVE MISSION' : 'AVAILABLE');
      el('strong', '', card, contract.name);
      el('p', '', card, contract.brief);
      el('div', 'contract-reward', card, `+${contract.rewardFunds.toLocaleString()} FUNDS · +${contract.rewardReputation} REP`);
      if (!completed && !active) {
        const accept = el('button', 'hud-btn contract-accept', card, 'Accept contract') as HTMLButtonElement;
        accept.disabled = game.campaign.activeContracts.length >= 3;
        accept.onclick = () => {
          const result = acceptContract(game.campaign, contract.id);
          if (!result.ok) return;
          settleContracts(game.campaign, game.flags);
          this.callbacks.onCampaignChanged();
          this.lastProgramSignature = '';
          this.renderProgram();
        };
      }
    }
  }

  private renderScience(): void {
    if (!this.scienceEl) return;
    const game = this.game();
    const records = this.scienceArchiveRecords(game);
    const stored = this.scienceAboardRecords(game);
    const ledgerSignature = [...game.scienceLedger]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${key}:${entry.cap}:${entry.deliveredByTransmit}:${entry.deliveredByRecovery}`)
      .join('|');
    const bufferSignature = stored
      .map((result) => `${result.vesselName}:${result.keyId}:${result.value}:${result.recoverOnly}`)
      .sort()
      .join('|');
    const signature = `${game.sciencePoints}:${ledgerSignature}:${bufferSignature}:${JSON.stringify(this.scienceFilters)}`;
    if (signature === this.lastScienceSignature) return;
    this.lastScienceSignature = signature;
    this.scienceEl.replaceChildren();
    this.scienceEl.classList.add('science-archive');

    let transmitted = 0;
    let recovered = 0;
    for (const entry of game.scienceLedger.values()) {
      transmitted += entry.deliveredByTransmit;
      recovered += entry.deliveredByRecovery;
    }
    const delivered = transmitted + recovered;
    const totalCap = records.reduce((total, record) => total + record.entry.cap, 0);
    const complete = records.filter((record) => record.status === 'complete').length;
    const archiveHeader = el('header', 'science-archive-header', this.scienceEl);
    const title = el('div', 'science-archive-title', archiveHeader);
    el('span', '', title, 'SYSTEM RESEARCH DOSSIER');
    el('strong', '', title, 'Science Archive');
    const metrics = el('div', 'science-archive-metrics', archiveHeader);
    this.scienceMetric(metrics, 'BALANCE', game.sciencePoints.toLocaleString(), 'SCI');
    this.scienceMetric(metrics, 'DELIVERED', delivered.toLocaleString(), `OF ${totalCap.toLocaleString()}`);
    this.scienceMetric(metrics, 'COVERAGE', `${complete}/${records.length}`, 'RECORDS');
    this.scienceMetric(metrics, 'ABOARD', aboardScienceValue(game).toLocaleString(), 'SCI');

    this.renderScienceFilters(game);
    const filteredRecords = filterScienceArchiveRecords(records, this.scienceFilters);
    const filteredAboard = stored.filter((record) => this.scienceAboardMatches(record));
    const worldsShown = new Set(filteredRecords.map((record) => record.key.bodyId)).size;
    const summary = el('div', 'science-filter-summary', this.scienceEl);
    el(
      'span',
      '',
      summary,
      this.scienceFilters.status === 'aboard'
        ? `${filteredAboard.length} result${filteredAboard.length === 1 ? '' : 's'} currently aboard`
        : `${filteredRecords.length} record${filteredRecords.length === 1 ? '' : 's'} across ${worldsShown} world${worldsShown === 1 ? '' : 's'}`,
    );
    el('span', '', summary, `${transmitted} transmitted / ${recovered} recovered`);

    const scroll = el('div', 'science-archive-scroll', this.scienceEl);
    scroll.tabIndex = 0;
    scroll.setAttribute('aria-label', 'Science archive results');
    if ((this.scienceFilters.status === 'all' || this.scienceFilters.status === 'aboard') && filteredAboard.length) {
      this.renderScienceAboard(scroll, filteredAboard);
    }
    if (this.scienceFilters.status !== 'aboard') this.renderScienceWorlds(scroll, records, filteredRecords);
    if ((this.scienceFilters.status === 'aboard' && !filteredAboard.length) ||
      (this.scienceFilters.status !== 'aboard' && !filteredRecords.length)) {
      const empty = el('div', 'science-empty-state', scroll);
      el('strong', '', empty, 'No records match this dossier view');
      el('span', '', empty, 'Clear a filter or search a different world, biome, experiment, or situation.');
    }
  }

  private scienceMetric(parent: HTMLElement, label: string, value: string, note: string): void {
    const metric = el('div', 'science-archive-metric', parent);
    el('span', '', metric, label);
    el('strong', '', metric, value);
    el('em', '', metric, note);
  }

  private renderScienceFilters(game: GameState): void {
    if (!this.scienceEl) return;
    const deck = el('div', 'science-filter-deck', this.scienceEl);
    const searchWrap = el('label', 'science-search', deck);
    el('span', '', searchWrap, 'SEARCH DOSSIER');
    const search = document.createElement('input');
    search.type = 'search';
    search.value = this.scienceFilters.query;
    search.placeholder = 'World, biome, situation, experiment…';
    search.setAttribute('aria-label', 'Search science archive');
    search.dataset.scienceSearch = 'true';
    searchWrap.appendChild(search);
    search.oninput = () => {
      this.scienceFilters.query = search.value;
      this.lastScienceSignature = '';
      this.renderScience();
      requestAnimationFrame(() => {
        const replacement = this.scienceEl?.querySelector<HTMLInputElement>('[data-science-search="true"]');
        replacement?.focus();
        replacement?.setSelectionRange(replacement.value.length, replacement.value.length);
      });
    };

    const controls = el('div', 'science-filter-controls', deck);
    this.scienceSelect(
      controls,
      'WORLD',
      this.scienceFilters.bodyId,
      [
        ['all', 'All worlds'],
        ...[...game.universe.bodies.values()].filter((body) => !body.def.isStar).map((body) => [body.id, body.name]),
      ],
      (value) => { this.scienceFilters.bodyId = value; },
    );
    this.scienceSelect(
      controls,
      'STATUS',
      this.scienceFilters.status,
      [
        ['all', 'All records'], ['unvisited', 'Unvisited'], ['in-progress', 'In progress'],
        ['complete', 'Complete'], ['aboard', 'Aboard now'],
      ],
      (value) => { this.scienceFilters.status = value as ScienceArchiveStatus; },
    );
    this.scienceSelect(
      controls,
      'EXPERIMENT',
      this.scienceFilters.experimentId,
      [['all', 'All experiments'], ...EXPERIMENTS.map((experiment) => [experiment.id, experiment.name])],
      (value) => { this.scienceFilters.experimentId = value; },
    );
    const situations = [...new Set(EXPERIMENTS.flatMap((experiment) => experiment.validSituations))];
    this.scienceSelect(
      controls,
      'SITUATION',
      this.scienceFilters.situation,
      [['all', 'All situations'], ...situations.map((situation) => [situation, situation.replace('-', ' ')])],
      (value) => { this.scienceFilters.situation = value; },
    );
    const clear = el('button', 'science-filter-clear', controls, 'Clear filters') as HTMLButtonElement;
    clear.disabled = !this.scienceFilters.query && this.scienceFilters.bodyId === 'all'
      && this.scienceFilters.status === 'all' && this.scienceFilters.experimentId === 'all'
      && this.scienceFilters.situation === 'all';
    clear.onclick = () => {
      this.scienceFilters = { query: '', bodyId: 'all', experimentId: 'all', situation: 'all', status: 'all' };
      this.lastScienceSignature = '';
      this.renderScience();
    };
  }

  private scienceSelect(
    parent: HTMLElement,
    label: string,
    value: string,
    options: string[][],
    change: (value: string) => void,
  ): void {
    const wrap = el('label', 'science-filter', parent);
    el('span', '', wrap, label);
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Filter science by ${label.toLocaleLowerCase()}`);
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      select.appendChild(option);
    }
    select.value = value;
    select.onchange = () => {
      change(select.value);
      this.lastScienceSignature = '';
      this.renderScience();
    };
    wrap.appendChild(select);
  }

  private scienceArchiveRecords(game: GameState): ScienceArchiveRecord[] {
    const records: ScienceArchiveRecord[] = [];
    const listedKeys = new Set<string>();
    for (const body of game.universe.bodies.values()) {
      if (body.def.isStar) continue;
      for (const experiment of EXPERIMENTS) {
        if (experiment.needsAtmosphere && !body.hasAtmosphere()) continue;
        for (const situation of experiment.validSituations) {
          for (const biome of scienceBiomesForSituation(body.def, situation)) {
            const key: ScienceKey = { experimentId: experiment.id, bodyId: body.id, biomeId: biome.id, situation };
            const keyId = encodeScienceKey(key);
            const entry = game.scienceLedger.get(keyId) ?? {
              cap: experimentCap(experiment, body.def.scienceValue, biome.scienceMultiplier),
              deliveredByTransmit: 0,
              deliveredByRecovery: 0,
            };
            records.push({
              keyId, key, entry, bodyName: body.name, biomeName: biome.name,
              experimentName: experiment.name, status: scienceArchiveStatus(entry),
            });
            listedKeys.add(keyId);
          }
        }
      }
    }
    for (const [keyId, entry] of game.scienceLedger) {
      if (listedKeys.has(keyId)) continue;
      const key = decodeScienceKey(keyId);
      if (!key) continue;
      const body = game.universe.bodies.get(key.bodyId);
      const biome = body?.def.biomes?.find((candidate) => candidate.id === key.biomeId);
      records.push({
        keyId,
        key,
        entry,
        bodyName: body?.name ?? key.bodyId,
        biomeName: biome?.name ?? key.biomeId,
        experimentName: EXPERIMENT_INDEX.get(key.experimentId)?.name ?? key.experimentId,
        status: scienceArchiveStatus(entry),
      });
    }
    return records;
  }

  private scienceAboardRecords(game: GameState): ScienceAboardRecord[] {
    return game.vessels.flatMap((vessel) => [...vessel.runtime.scienceBuffer.entries()].map(([keyId, result]) => {
      const key = decodeScienceKey(keyId);
      const body = key ? game.universe.bodies.get(key.bodyId) : null;
      const biome = body?.def.biomes?.find((candidate) => candidate.id === key?.biomeId);
      const ledger = game.scienceLedger.get(keyId);
      const remainingCap = ledger ? Math.max(0, ledger.cap - deliveredScience(ledger)) : result.siteCapAtCollection;
      return {
        keyId,
        key,
        bodyName: body?.name ?? key?.bodyId ?? 'Unknown world',
        biomeName: biome?.name ?? key?.biomeId ?? 'Unknown biome',
        experimentName: (key && EXPERIMENT_INDEX.get(key.experimentId)?.name) ?? keyId,
        vesselName: vessel.runtime.name,
        value: Math.min(Math.max(0, result.heldValue - result.transmittedFromThis), remainingCap),
        recoverOnly: result.transmitTarget === 0,
      };
    }));
  }

  private scienceAboardMatches(record: ScienceAboardRecord): boolean {
    if (this.scienceFilters.status !== 'all' && this.scienceFilters.status !== 'aboard') return false;
    if (this.scienceFilters.bodyId !== 'all' && record.key?.bodyId !== this.scienceFilters.bodyId) return false;
    if (this.scienceFilters.experimentId !== 'all' && record.key?.experimentId !== this.scienceFilters.experimentId) return false;
    if (this.scienceFilters.situation !== 'all' && record.key?.situation !== this.scienceFilters.situation) return false;
    const query = this.scienceFilters.query.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${record.bodyName} ${record.biomeName} ${record.experimentName} ${record.vesselName} ${record.key?.situation ?? ''}`
      .toLocaleLowerCase()
      .includes(query);
  }

  private renderScienceAboard(parent: HTMLElement, records: readonly ScienceAboardRecord[]): void {
    const section = el('section', 'science-aboard-section', parent);
    const heading = el('div', 'science-section-heading', section);
    const copy = el('div', '', heading);
    el('span', '', copy, 'IN TRANSIT');
    el('strong', '', copy, 'Results aboard active vessels');
    el('em', '', heading, `${records.reduce((total, record) => total + record.value, 0)} SCI`);
    const grid = el('div', 'science-aboard-grid', section);
    for (const record of records) {
      const card = el('article', `science-aboard-card${record.recoverOnly ? ' recover-only' : ''}`, grid);
      el('span', 'science-aboard-vessel', card, record.vesselName);
      el('strong', '', card, record.experimentName);
      el('div', 'science-aboard-location', card, `${record.bodyName} / ${record.biomeName} / ${record.key?.situation ?? 'unknown'}`);
      el('div', 'science-aboard-value', card, record.recoverOnly ? `${record.value} SCI · RECOVER ONLY` : `${record.value} SCI REMAINING`);
    }
  }

  private renderScienceWorlds(
    parent: HTMLElement,
    allRecords: readonly ScienceArchiveRecord[],
    records: readonly ScienceArchiveRecord[],
  ): void {
    const bodies = new Map<string, ScienceArchiveRecord[]>();
    for (const record of records) {
      const group = bodies.get(record.key.bodyId) ?? [];
      group.push(record);
      bodies.set(record.key.bodyId, group);
    }
    const forceOpen = Boolean(this.scienceFilters.query) || this.scienceFilters.bodyId !== 'all'
      || this.scienceFilters.experimentId !== 'all' || this.scienceFilters.situation !== 'all'
      || this.scienceFilters.status !== 'all';
    for (const [bodyId, bodyRecords] of bodies) {
      const bodyAll = allRecords.filter((record) => record.key.bodyId === bodyId);
      const complete = bodyAll.filter((record) => record.status === 'complete').length;
      const delivered = bodyAll.reduce((total, record) => total + deliveredScience(record.entry), 0);
      const cap = bodyAll.reduce((total, record) => total + record.entry.cap, 0);
      const details = document.createElement('details');
      details.className = 'science-world-dossier';
      details.open = forceOpen || this.scienceOpenBodies.has(bodyId);
      details.dataset.bodyId = bodyId;
      details.addEventListener('toggle', () => {
        if (details.open) this.scienceOpenBodies.add(bodyId);
        else this.scienceOpenBodies.delete(bodyId);
      });
      parent.appendChild(details);
      const summary = el('summary', 'science-world-summary', details);
      const identity = el('div', 'science-world-identity', summary);
      el('span', '', identity, bodyId.toLocaleUpperCase());
      el('strong', '', identity, bodyRecords[0].bodyName);
      const progress = el('div', 'science-world-progress', summary);
      el('span', '', progress, `${complete}/${bodyAll.length} complete`);
      const rail = el('div', 'science-progress-rail', progress);
      const fill = el('div', '', rail);
      fill.style.width = `${cap > 0 ? Math.min(100, delivered / cap * 100) : 0}%`;
      el('em', '', summary, `${bodyRecords.length} shown`);

      const sites = new Map<string, ScienceArchiveRecord[]>();
      for (const record of bodyRecords) {
        const siteId = `${record.key.biomeId}\u0000${record.key.situation}`;
        const site = sites.get(siteId) ?? [];
        site.push(record);
        sites.set(siteId, site);
      }
      const grid = el('div', 'science-site-grid', details);
      for (const [siteId, siteRecords] of sites) {
        const [biomeId, situation] = siteId.split('\u0000');
        const aggregate = siteRecords.every((record) => record.status === 'complete')
          ? 'complete'
          : siteRecords.some((record) => record.status !== 'unvisited') ? 'in-progress' : 'unvisited';
        const card = el('article', `science-site-card ${aggregate}`, grid);
        const siteHeader = el('header', 'science-site-header', card);
        const siteCopy = el('div', '', siteHeader);
        el('span', '', siteCopy, biomeId.toLocaleUpperCase());
        el('strong', '', siteCopy, siteRecords[0].biomeName);
        el('em', '', siteHeader, situation.replace('-', ' '));
        const resultList = el('div', 'science-record-list', card);
        for (const record of [...siteRecords].sort((a, b) => a.experimentName.localeCompare(b.experimentName))) {
          const delivered = deliveredScience(record.entry);
          const remaining = Math.max(0, record.entry.cap - delivered);
          const row = el('div', 'science-record-row', resultList);
          const recordCopy = el('div', 'science-record-copy', row);
          el('strong', '', recordCopy, record.experimentName);
          el('span', `science-record-state ${record.status}`, recordCopy, record.status.replace('-', ' '));
          const channels = el('div', 'science-record-channels', row);
          el('span', '', channels, `T ${record.entry.deliveredByTransmit}`);
          el('span', '', channels, `R ${record.entry.deliveredByRecovery}`);
          const remainingEl = el('div', 'science-record-remaining', row, `${remaining}/${record.entry.cap}`);
          remainingEl.title = `${remaining} science remaining from a cap of ${record.entry.cap}`;
          const rail = el('div', 'science-record-rail', row);
          const fill = el('div', '', rail);
          fill.style.width = `${record.entry.cap > 0 ? Math.min(100, delivered / record.entry.cap * 100) : 0}%`;
        }
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
