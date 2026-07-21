import { el, injectUiStyles } from './kit';

export type MissionReplayCamera = 'director' | 'gateway' | 'orion' | 'moon' | 'free';
export type MissionReplayLayer = 'reference-orbit' | 'approach-corridor' | 'labels' | 'telemetry' | 'source-notes';

export interface MissionReplayPhaseView {
  readonly id: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly contextOnly?: boolean;
}

export interface MissionReplaySourceView {
  readonly label: string;
  readonly url: string;
  readonly fidelity: string;
}

export interface MissionReplayView {
  readonly time: number;
  readonly duration: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly phaseIndex: number;
  readonly phases: readonly MissionReplayPhaseView[];
  readonly narrative: string;
  readonly fidelity: string;
  readonly rangeMeters: number;
  readonly closingRateMps: number;
  readonly relativeSpeedMps: number;
  readonly eventLabel?: string;
  readonly camera: MissionReplayCamera;
  readonly directorActive: boolean;
  readonly layers: Readonly<Record<MissionReplayLayer, boolean>>;
  readonly disclaimer: string;
  readonly sources: readonly MissionReplaySourceView[];
}

export interface MissionReplayCallbacks {
  onTogglePlay(): void;
  onSeek(time: number): void;
  onPreviousPhase(): void;
  onNextPhase(): void;
  onRestartPhase(): void;
  onRate(rate: number): void;
  onCamera(camera: MissionReplayCamera): void;
  onReturnToDirector(): void;
  onLayer(layer: MissionReplayLayer, enabled: boolean): void;
  onExit(): void;
}

export function formatMissionTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  return days > 0
    ? `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatMissionDistance(meters: number): string {
  const magnitude = Math.abs(meters);
  if (magnitude >= 1_000_000) return `${(meters / 1_000_000).toFixed(2)} Mm`;
  if (magnitude >= 1_000) return `${(meters / 1_000).toFixed(2)} km`;
  return `${meters.toFixed(magnitude < 10 ? 2 : 0)} m`;
}

/** DOM-only replay controls. Rendering and mission evaluation remain external. */
export class MissionReplay {
  readonly root: HTMLElement;
  private readonly phaseOrdinal: HTMLElement;
  private readonly phaseTitle: HTMLElement;
  private readonly narrative: HTMLElement;
  private readonly fidelity: HTMLElement;
  private readonly event: HTMLElement;
  private readonly range: HTMLElement;
  private readonly closingRate: HTMLElement;
  private readonly relativeSpeed: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly timeline: HTMLInputElement;
  private readonly timelineValue: HTMLOutputElement;
  private readonly phaseMarkers: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly rateSelect: HTMLSelectElement;
  private readonly cameraButtons = new Map<MissionReplayCamera, HTMLButtonElement>();
  private readonly layerInputs = new Map<MissionReplayLayer, HTMLInputElement>();
  private readonly returnDirector: HTMLButtonElement;
  private readonly sourcePanel: HTMLElement;
  private readonly sourceList: HTMLElement;
  private timelinePointerActive = false;
  private lastPhaseSignature = '';
  private lastSourceSignature = '';

  constructor(parent: HTMLElement, private readonly callbacks: MissionReplayCallbacks) {
    injectUiStyles();
    this.root = el('section', 'mission-replay', parent);
    // Beat the more-specific #ui-root > * rule so the open 3D stage remains
    // directly manipulable; individual replay panels opt back in via CSS.
    this.root.style.pointerEvents = 'none';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Artemis IV mission replay');

    const top = el('header', 'mission-replay-top', this.root);
    const identity = el('div', 'mission-replay-identity', top);
    el('span', '', identity, 'ARTEMIS IV');
    el('strong', '', identity, 'LUNAR GATEWAY REPLAY');
    const exit = el('button', 'mission-replay-exit', top, 'Exit Replay') as HTMLButtonElement;
    exit.type = 'button';
    exit.addEventListener('click', () => this.callbacks.onExit());

    const story = el('aside', 'mission-replay-story', this.root);
    this.phaseOrdinal = el('div', 'mission-replay-phase-ordinal', story);
    this.phaseTitle = el('h1', 'mission-replay-phase-title', story);
    this.narrative = el('p', 'mission-replay-narrative', story);
    this.event = el('div', 'mission-replay-event', story);
    this.event.setAttribute('aria-live', 'polite');
    this.fidelity = el('div', 'mission-replay-fidelity', story);

    const telemetry = el('details', 'mission-replay-telemetry', this.root) as HTMLDetailsElement;
    el('summary', 'mission-replay-drawer-summary', telemetry, 'Telemetry');
    const compactReplay = window.matchMedia?.('(max-width: 850px)');
    const syncTelemetryDrawer = (compact: boolean) => { telemetry.open = !compact; };
    if (compactReplay) {
      syncTelemetryDrawer(compactReplay.matches);
      compactReplay.addEventListener('change', (event) => syncTelemetryDrawer(event.matches));
    } else {
      telemetry.open = true;
    }
    el('h2', '', telemetry, 'RELATIVE NAVIGATION');
    this.range = this.telemetryRow(telemetry, 'RANGE');
    this.closingRate = this.telemetryRow(telemetry, 'CLOSING RATE');
    this.relativeSpeed = this.telemetryRow(telemetry, 'RELATIVE SPEED');
    this.elapsed = this.telemetryRow(telemetry, 'MISSION TIME');

    const views = el('div', 'mission-replay-views', this.root);
    el('span', 'mission-replay-control-label', views, 'VIEW');
    for (const [camera, label] of [
      ['director', 'Director'],
      ['gateway', 'Gateway'],
      ['orion', 'Orion'],
      ['moon', 'Moon'],
      ['free', 'Free'],
    ] as const) {
      const button = el('button', 'mission-replay-chip', views, label) as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => this.callbacks.onCamera(camera));
      this.cameraButtons.set(camera, button);
    }
    this.returnDirector = el('button', 'mission-replay-chip return-director', views, 'Return to Director') as HTMLButtonElement;
    this.returnDirector.type = 'button';
    this.returnDirector.addEventListener('click', () => this.callbacks.onReturnToDirector());

    const layers = el('details', 'mission-replay-layers', this.root) as HTMLDetailsElement;
    el('summary', '', layers, 'Layers');
    const layerGrid = el('div', 'mission-replay-layer-grid', layers);
    for (const [layer, label] of [
      ['reference-orbit', 'Reference orbit'],
      ['approach-corridor', 'Approach corridor'],
      ['labels', 'Entity labels'],
      ['telemetry', 'Telemetry'],
      ['source-notes', 'Source notes'],
    ] as const) {
      const row = el('label', '', layerGrid);
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => this.callbacks.onLayer(layer, input.checked));
      row.append(input, document.createTextNode(label));
      this.layerInputs.set(layer, input);
    }

    this.sourcePanel = el('aside', 'mission-replay-source-notes', this.root);
    this.sourcePanel.hidden = true;
    el('h2', '', this.sourcePanel, 'SOURCES & ASSUMPTIONS');
    el('p', 'mission-replay-source-disclaimer', this.sourcePanel);
    this.sourceList = el('ul', '', this.sourcePanel);

    const controls = el('footer', 'mission-replay-controls', this.root);
    this.phaseMarkers = el('div', 'mission-replay-phase-markers', controls);
    const timelineRow = el('div', 'mission-replay-timeline-row', controls);
    this.timelineValue = el('output', 'mission-replay-time', timelineRow, '00:00:00') as HTMLOutputElement;
    this.timeline = el('input', 'mission-replay-timeline', timelineRow) as HTMLInputElement;
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '1';
    this.timeline.step = '0.1';
    this.timeline.value = '0';
    this.timeline.setAttribute('aria-label', 'Mission timeline');
    this.timeline.addEventListener('pointerdown', () => { this.timelinePointerActive = true; });
    const finishTimelinePointer = () => { this.timelinePointerActive = false; };
    this.timeline.addEventListener('pointerup', finishTimelinePointer);
    this.timeline.addEventListener('pointercancel', finishTimelinePointer);
    this.timeline.addEventListener('lostpointercapture', finishTimelinePointer);
    this.timeline.addEventListener('change', finishTimelinePointer);
    this.timeline.addEventListener('input', () => this.callbacks.onSeek(Number(this.timeline.value)));

    const transport = el('div', 'mission-replay-transport', controls);
    this.previousButton = this.transportButton(transport, 'Previous phase', '◀ PHASE', () => this.callbacks.onPreviousPhase());
    this.playButton = this.transportButton(transport, 'Play mission replay', 'PLAY', () => this.callbacks.onTogglePlay());
    this.transportButton(transport, 'Restart current phase', 'RESTART', () => this.callbacks.onRestartPhase());
    this.nextButton = this.transportButton(transport, 'Next phase', 'PHASE ▶', () => this.callbacks.onNextPhase());
    const rateLabel = el('label', 'mission-replay-rate', transport);
    rateLabel.append(document.createTextNode('RATE '));
    this.rateSelect = document.createElement('select');
    this.rateSelect.setAttribute('aria-label', 'Playback rate');
    for (const rate of [0.25, 1, 10, 100, 1000]) {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate}×`;
      this.rateSelect.appendChild(option);
    }
    this.rateSelect.addEventListener('change', () => this.callbacks.onRate(Number(this.rateSelect.value)));
    rateLabel.appendChild(this.rateSelect);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (visible) requestAnimationFrame(() => this.playButton.focus());
  }

  update(view: MissionReplayView): void {
    const phase = view.phases[view.phaseIndex] ?? view.phases[0];
    this.phaseOrdinal.textContent = `PHASE ${String(view.phaseIndex + 1).padStart(2, '0')} / ${String(view.phases.length).padStart(2, '0')}`;
    this.phaseTitle.textContent = phase?.title ?? 'MISSION REPLAY';
    this.narrative.textContent = view.narrative;
    this.fidelity.textContent = view.fidelity;
    this.event.textContent = view.eventLabel ?? '';
    this.event.hidden = !view.eventLabel;
    this.range.textContent = formatMissionDistance(view.rangeMeters);
    this.closingRate.textContent = `${view.closingRateMps.toFixed(2)} m/s`;
    this.relativeSpeed.textContent = `${view.relativeSpeedMps.toFixed(2)} m/s`;
    this.elapsed.textContent = formatMissionTime(view.time);
    this.timeline.max = String(Math.max(0.1, view.duration));
    if (!this.timelinePointerActive) this.timeline.value = String(view.time);
    this.timelineValue.value = formatMissionTime(view.time);
    this.playButton.textContent = view.playing ? 'PAUSE' : 'PLAY';
    this.playButton.setAttribute('aria-label', view.playing ? 'Pause mission replay' : 'Play mission replay');
    this.playButton.setAttribute('aria-pressed', String(view.playing));
    this.previousButton.disabled = view.phaseIndex <= 0;
    this.nextButton.disabled = view.phaseIndex >= view.phases.length - 1;
    this.rateSelect.value = String(view.rate);
    for (const [camera, button] of this.cameraButtons) {
      const active = view.camera === camera && (camera !== 'director' || view.directorActive);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    this.returnDirector.hidden = view.directorActive;
    for (const [layer, input] of this.layerInputs) input.checked = view.layers[layer];
    this.root.classList.toggle('telemetry-hidden', !view.layers.telemetry);
    this.sourcePanel.hidden = !view.layers['source-notes'];
    const disclaimer = this.sourcePanel.querySelector('.mission-replay-source-disclaimer');
    if (disclaimer) disclaimer.textContent = view.disclaimer;
    const sourceSignature = view.sources.map((source) => `${source.label}:${source.url}:${source.fidelity}`).join('|');
    if (sourceSignature !== this.lastSourceSignature) {
      this.lastSourceSignature = sourceSignature;
      this.sourceList.replaceChildren();
      for (const source of view.sources) {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = source.url;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        anchor.textContent = source.label;
        const fidelity = document.createElement('span');
        fidelity.textContent = source.fidelity;
        item.append(anchor, fidelity);
        this.sourceList.appendChild(item);
      }
    }

    const phaseSignature = view.phases.map((candidate) => `${candidate.id}:${candidate.start}:${candidate.end}`).join('|');
    if (phaseSignature !== this.lastPhaseSignature) {
      this.lastPhaseSignature = phaseSignature;
      this.phaseMarkers.replaceChildren();
      this.phaseMarkers.style.gridTemplateColumns = `repeat(${view.phases.length},minmax(0,1fr))`;
      for (const [index, candidate] of view.phases.entries()) {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = `mission-replay-marker${candidate.contextOnly ? ' context-only' : ''}`;
        marker.textContent = String(index + 1);
        marker.title = candidate.title;
        marker.setAttribute('aria-label', `Go to phase ${index + 1}: ${candidate.title}`);
        marker.addEventListener('click', () => this.callbacks.onSeek(candidate.start));
        this.phaseMarkers.appendChild(marker);
      }
    }
    [...this.phaseMarkers.children].forEach((marker, index) => {
      marker.classList.toggle('active', index === view.phaseIndex);
      marker.setAttribute('aria-current', index === view.phaseIndex ? 'step' : 'false');
    });
  }

  private telemetryRow(parent: HTMLElement, label: string): HTMLElement {
    const row = el('div', 'mission-replay-telemetry-row', parent);
    el('span', '', row, label);
    return el('strong', '', row, '—');
  }

  private transportButton(parent: HTMLElement, ariaLabel: string, text: string, fn: () => void): HTMLButtonElement {
    const button = el('button', 'mission-replay-transport-button', parent, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', fn);
    return button;
  }
}
