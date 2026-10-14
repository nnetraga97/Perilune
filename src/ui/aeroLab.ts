import { renderScene, type RenderContext } from '../render/context';
import { buildAeroModel, type AeroModel } from '../sim/aero';
import {
  evaluateAeroLab,
  type AeroLabCondition,
  type AeroLabEnvironment,
  type AeroLabReading,
} from '../sim/aeroLab';
import type { Craft } from '../sim/vessel';
import type { Body } from '../sim/universe';
import { buildAeroLabSurface } from '../render/aeroLabGeometry';
import {
  AeroLabScene,
  type AeroLabSurfaceMode,
} from '../render/aeroLabScene';
import type { AeroLabFieldResult, AeroLabQuality } from '../render/aeroLabAnalysis';
import type { PartModelLibrary } from '../render/partModelLibrary';
import { el, injectUiStyles } from './kit';

interface AeroLabCallbacks {
  onBack(): void;
  onAnalysisError(errorType: string): void;
}

interface WorkerResult {
  requestId: number;
  result?: AeroLabFieldResult;
  error?: string;
}

function number(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
}

function force(value: number): string {
  if (value >= 1_000_000) return `${number(value / 1_000_000, 2)} MN`;
  if (value >= 1_000) return `${number(value / 1_000, 2)} kN`;
  return `${number(value, 1)} N`;
}

export class AeroLab {
  readonly root: HTMLElement;
  readonly scene: AeroLabScene;

  private craft: Craft | null = null;
  private environment: AeroLabEnvironment | null = null;
  private model: AeroModel | null = null;
  private reading: AeroLabReading | null = null;
  private condition: AeroLabCondition = { altitude: 0, mach: 0.3, orientationDeg: 0 };
  private quality: AeroLabQuality = 'medium';
  private worker: Worker | null = null;
  private requestId = 0;
  private debounce: number | null = null;
  private slowTimer: number | null = null;
  private visible = false;
  private readonly statusEl: HTMLElement;
  private readonly regimeEl: HTMLElement;
  private readonly metricsEl: HTMLElement;
  private readonly legendEl: HTMLElement;
  private readonly altitudeInput: HTMLInputElement;
  private readonly altitudeValue: HTMLElement;
  private readonly machInput: HTMLInputElement;
  private readonly machValue: HTMLElement;
  private readonly orientationInput: HTMLInputElement;
  private readonly orientationValue: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly bodySelect: HTMLSelectElement;
  private readonly presetButtons: HTMLButtonElement[] = [];
  private bodies: Body[] = [];
  private mode: AeroLabSurfaceMode = 'flow';
  private paused: boolean;

  constructor(
    uiRoot: HTMLElement,
    models: PartModelLibrary,
    private readonly context: RenderContext,
    private readonly callbacks: AeroLabCallbacks,
  ) {
    injectUiStyles();
    this.scene = new AeroLabScene(models, context.renderer.domElement);
    this.paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root = el('section', 'aero-lab', uiRoot);
    this.root.setAttribute('aria-label', 'Aerodynamics Lab');

    const header = el('header', 'aero-lab-header', this.root);
    const title = el('div', '', header);
    el('div', 'aero-lab-kicker', title, 'VAB ANALYSIS TOOL');
    el('h1', '', title, 'AERODYNAMICS LAB');
    const headerActions = el('div', 'aero-lab-header-actions', header);
    this.statusEl = el('span', 'aero-lab-status', headerActions, 'READY');
    const resetView = el('button', 'hud-btn', headerActions, 'RESET VIEW') as HTMLButtonElement;
    resetView.onclick = () => this.scene.resetCamera();
    const back = el('button', 'hud-btn', headerActions, '← BACK TO WORKSHOP') as HTMLButtonElement;
    back.onclick = () => this.callbacks.onBack();

    const controls = el('aside', 'aero-lab-panel aero-lab-controls', this.root);
    const bodyRow = el('label', 'aero-lab-field aero-lab-field-environment', controls);
    el('span', '', bodyRow, 'Environment');
    this.bodySelect = el('select', '', bodyRow) as HTMLSelectElement;
    this.bodySelect.onchange = () => this.selectBody(this.bodySelect.value);
    const presetGroup = el('div', 'aero-lab-toolbar-group aero-lab-preset-group', controls);
    el('span', '', presetGroup, 'Scenario');
    const presets = el('div', 'aero-lab-presets', presetGroup);
    for (const [id, label] of [['ascent', 'ASCENT'], ['high-q', 'HIGH Q'], ['reentry', 'RE-ENTRY']] as const) {
      const button = el('button', 'hud-btn', presets, label) as HTMLButtonElement;
      button.onclick = () => this.applyPreset(id);
      this.presetButtons.push(button);
    }

    [this.altitudeInput, this.altitudeValue] = this.slider(
      controls,
      'Altitude',
      0,
      100_000,
      100,
      (value) => `${number(value / 1_000, 1)} km`,
    );
    [this.machInput, this.machValue] = this.slider(
      controls,
      'Mach',
      0,
      10,
      0.05,
      (value) => number(value, 2),
    );
    [this.orientationInput, this.orientationValue] = this.slider(
      controls,
      'Craft orientation',
      0,
      180,
      1,
      (value) => `${number(value, 0)}°`,
    );
    for (const input of [this.altitudeInput, this.machInput, this.orientationInput]) {
      input.oninput = () => this.readControls();
    }

    const qualityRow = el('label', 'aero-lab-field aero-lab-field-quality', controls);
    el('span', '', qualityRow, 'Flow detail');
    const quality = el('select', '', qualityRow) as HTMLSelectElement;
    for (const value of ['low', 'medium', 'high'] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value.toUpperCase();
      quality.appendChild(option);
    }
    quality.value = this.quality;
    quality.onchange = () => {
      this.quality = quality.value as AeroLabQuality;
      this.scheduleAnalysis(0);
    };

    const modeGroup = el('div', 'aero-lab-toolbar-group aero-lab-mode-group', controls);
    el('span', '', modeGroup, 'Visualization');
    const modes = el('div', 'aero-lab-modes', modeGroup);
    for (const [mode, label] of [
      ['flow', 'FLOW'],
      ['load', 'LOAD'],
      ['thermal', 'HEATING'],
      ['shielding', 'SHIELDING'],
    ] as const) {
      const button = el('button', 'hud-btn', modes, label) as HTMLButtonElement;
      button.dataset.mode = mode;
      button.classList.toggle('active', mode === this.mode);
      button.onclick = () => {
        this.mode = mode;
        this.scene.setSurfaceMode(mode);
        for (const child of modes.children) child.classList.toggle('active', child === button);
        this.updateLegend();
      };
    }
    this.pauseButton = el('button', 'hud-btn aero-lab-pause', controls) as HTMLButtonElement;
    this.pauseButton.onclick = () => this.togglePaused();
    this.syncPauseButton();

    this.legendEl = el('aside', 'aero-lab-scale', this.root);
    this.updateLegend();

    const results = el('aside', 'aero-lab-panel aero-lab-results', this.root);
    el('h2', '', results, 'FLIGHT MODEL');
    this.regimeEl = el('div', 'aero-lab-regime', results);
    this.metricsEl = el('dl', 'aero-lab-metrics', results);
    el('p', 'aero-lab-marker-key', results, '● CoM   ● Axial CoP   → Total aerodynamic force');
    el(
      'p',
      'aero-lab-note',
      results,
      'Forces and moments use the same model as flight. Streamlines and surface colors are visual approximations, not CFD.',
    );

    el('div', 'aero-lab-hint', this.root, 'DRAG TO ORBIT · WHEEL TO ZOOM · SPACE TO PAUSE · ESC TO RETURN');
    this.setVisible(false);
  }

  open(craft: Craft, environment: AeroLabEnvironment, bodies: Body[]): void {
    this.closeWorker();
    this.craft = structuredClone(craft);
    this.environment = environment;
    this.bodies = bodies;
    this.bodySelect.replaceChildren();
    for (const body of bodies) {
      const option = document.createElement('option');
      option.value = body.id;
      option.textContent = body.name;
      this.bodySelect.appendChild(option);
    }
    this.bodySelect.value = environment.body.id;
    for (const button of this.presetButtons) button.disabled = !environment.body.hasAtmosphere();
    this.model = buildAeroModel(this.craft);
    this.scene.setCraft(this.craft);
    this.scene.setControlsEnabled(true);
    this.condition = {
      altitude: environment.altitude,
      mach: environment.vacuum ? 0 : 0.3,
      orientationDeg: 0,
    };
    const atmosphereHeight = environment.body.def.atmosphere?.height ?? 0;
    this.altitudeInput.max = String(Math.max(1_000, atmosphereHeight));
    this.syncControls();
    this.visible = true;
    this.setVisible(true);
    this.scene.setPaused(this.paused);
    this.evaluate();
    this.scheduleAnalysis(0);
  }

  close(): void {
    this.visible = false;
    this.setVisible(false);
    this.closeWorker();
    this.scene.clearAnalysis();
    this.scene.clearCraft();
    this.scene.setControlsEnabled(false);
    this.craft = null;
    this.environment = null;
    this.model = null;
  }

  update(dt: number): void {
    if (this.visible) this.scene.update(dt);
  }

  render(): void {
    renderScene(this.context, this.scene.scene, this.scene.camera);
  }

  togglePaused(): void {
    this.paused = !this.paused;
    this.scene.setPaused(this.paused);
    this.syncPauseButton();
  }

  testState(): Record<string, unknown> {
    return {
      status: this.statusEl.textContent,
      mach: this.reading?.mach ?? null,
      dynamicPressure: this.reading?.dynamicPressure ?? null,
      drag: this.reading?.drag ?? null,
      mode: this.mode,
      cameraPosition: this.scene.camera.position.toArray(),
    };
  }

  private slider(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ): [HTMLInputElement, HTMLElement] {
    const row = el('label', 'aero-lab-field aero-lab-field-slider', parent);
    const heading = el('span', 'aero-lab-field-heading', row);
    el('span', '', heading, label);
    const value = el('output', '', heading, format(min));
    const input = el('input', '', row) as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.format = label;
    input.setAttribute('aria-label', label);
    return [input, value];
  }

  private readControls(): void {
    this.condition = {
      altitude: Number(this.altitudeInput.value),
      mach: Number(this.machInput.value),
      orientationDeg: Number(this.orientationInput.value),
    };
    this.syncControls();
    this.evaluate();
    this.scheduleAnalysis(100);
  }

  private syncControls(): void {
    this.altitudeInput.value = String(this.condition.altitude);
    this.machInput.value = String(this.condition.mach);
    this.orientationInput.value = String(this.condition.orientationDeg);
    this.altitudeValue.textContent = `${number(this.condition.altitude / 1_000, 1)} km`;
    this.machValue.textContent = number(this.condition.mach, 2);
    this.orientationValue.textContent = `${number(this.condition.orientationDeg, 0)}°`;
  }

  private applyPreset(preset: 'ascent' | 'high-q' | 'reentry'): void {
    if (!this.environment) return;
    const height = this.environment.body.def.atmosphere?.height ?? 0;
    if (preset === 'ascent') this.condition = { altitude: height * 0.02, mach: 0.3, orientationDeg: 0 };
    else if (preset === 'high-q') {
      const altitude = height * 0.15;
      const density = this.environment.body.densityAt(altitude);
      const soundSpeed = this.environment.body.speedOfSoundAt(altitude);
      const mach = density > 0 && soundSpeed > 0 ? Math.sqrt(2 * 35_000 / density) / soundSpeed : 0;
      this.condition = { altitude, mach: Math.min(10, mach), orientationDeg: 0 };
    }
    else this.condition = { altitude: height * 0.55, mach: 6.5, orientationDeg: 180 };
    this.syncControls();
    this.evaluate();
    this.scheduleAnalysis(0);
  }

  private selectBody(bodyId: string): void {
    const body = this.bodies.find((candidate) => candidate.id === bodyId);
    if (!body) return;
    this.environment = { body, altitude: 0, vacuum: !body.hasAtmosphere() };
    const height = body.def.atmosphere?.height ?? 0;
    this.condition = { altitude: 0, mach: body.hasAtmosphere() ? 0.3 : 0, orientationDeg: 0 };
    this.altitudeInput.max = String(Math.max(1_000, height));
    for (const button of this.presetButtons) button.disabled = !body.hasAtmosphere();
    this.syncControls();
    this.evaluate();
    this.scheduleAnalysis(0);
  }

  private evaluate(): void {
    if (!this.craft || !this.environment || !this.model) return;
    this.reading = evaluateAeroLab(this.craft, this.environment.body, this.condition, this.model);
    this.scene.updateReading(this.condition, this.reading);
    this.renderMetrics();
  }

  private renderMetrics(): void {
    const reading = this.reading;
    if (!reading) return;
    const vacuum = reading.density <= 0;
    const tailFirst = this.condition.orientationDeg > 135;
    const warnings = vacuum
      ? 'VACUUM · NO AIRFLOW'
      : this.condition.mach > 7
        ? 'EXTREME HYPERSONIC · LOW MODEL CONFIDENCE'
        : tailFirst
          ? 'TAIL-FIRST · LOW MODEL CONFIDENCE'
          : this.condition.mach > 1.2
            ? 'SUPERSONIC · SHOCK ENVELOPE IS APPROXIMATE'
            : this.condition.mach >= 0.8
              ? 'TRANSONIC · FLOW FIELD IS ILLUSTRATIVE'
              : 'SUBSONIC · BEST-SUPPORTED REGIME';
    this.regimeEl.textContent = warnings;
    const stability = (reading.copY - reading.comY) * reading.flowAlign;
    const stabilityLabel = Math.abs(stability) < 0.02
      ? 'NEUTRAL'
      : stability < 0 ? 'RESTORING' : 'UPSETTING';
    const entries = [
      ['Speed', `${number(reading.speed, 0)} m/s`],
      ['Dynamic pressure', `${number(reading.dynamicPressure / 1_000, 2)} kPa`],
      ['Drag', force(reading.drag)],
      ['Lift', force(reading.lift)],
      ['Lift / drag', reading.liftToDrag === null ? '—' : number(reading.liftToDrag, 2)],
      ['Torque', `${number(reading.torque, 0)} N·m`],
      ['Flight-model AoA', `${number(reading.modelAoaDeg, 1)}°`],
      ['Heating flux proxy', number(reading.heatFlux, 0)],
      ['Stability tendency', stabilityLabel],
      ['CoM → axial CoP', `${stability >= 0 ? '+' : ''}${number(stability, 2)} m`],
      ['Mass', `${number(reading.mass / 1_000, 2)} t`],
    ];
    this.metricsEl.replaceChildren();
    for (const [label, value] of entries) {
      el('dt', '', this.metricsEl, label);
      el('dd', '', this.metricsEl, value);
    }
  }

  private scheduleAnalysis(delay: number): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.requestId++;
    this.statusEl.textContent = 'UPDATING FLOW';
    this.scene.setAnalysisPending(true);
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      this.startAnalysis();
    }, delay);
  }

  private startAnalysis(): void {
    if (!this.craft || !this.reading || this.reading.density <= 0) {
      this.scene.clearAnalysis();
      this.statusEl.textContent = 'VACUUM';
      return;
    }
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/aeroLabWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => this.receiveAnalysis(event.data);
    }
    const requestId = ++this.requestId;
    this.statusEl.textContent = 'BUILDING SURFACE';
    const surface = buildAeroLabSurface(this.craft);
    const angle = this.condition.orientationDeg * Math.PI / 180;
    this.statusEl.textContent = 'TRACING FLOW';
    this.worker.postMessage({
      requestId,
      request: {
        surface,
        flowDirection: [-Math.sin(angle), -Math.cos(angle), 0],
        mach: this.condition.mach,
        quality: this.quality,
      },
    }, [surface.positions.buffer, surface.normals.buffer, surface.partKeys.buffer]);
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.slowTimer = window.setTimeout(() => {
      if (requestId === this.requestId) this.statusEl.textContent = 'STILL PREPARING · RESULTS REMAIN AVAILABLE';
    }, 2_000);
  }

  private receiveAnalysis(message: WorkerResult): void {
    if (message.requestId !== this.requestId || !this.craft || !this.model || !this.reading) return;
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.slowTimer = null;
    if (!message.result) {
      this.statusEl.textContent = 'SIMPLIFIED VIEW';
      this.scene.clearAnalysis();
      this.callbacks.onAnalysisError(message.error ?? 'AeroLabAnalysisError');
      return;
    }
    this.scene.setAnalysis(message.result, this.condition, this.reading);
    this.scene.setAnalysisPending(false);
    this.scene.setSurfaceMode(this.mode);
    this.statusEl.textContent = `READY · ${number(message.result.preparationMs, 0)} ms`;
  }

  private updateLegend(): void {
    const content = this.mode === 'flow'
      ? ['FLOW PATH', 'UPSTREAM', 'FIELD', 'DOWNSTREAM', 'Approximate direction']
      : this.mode === 'load'
        ? ['RELATIVE LOAD', '100%', '50%', '0%', 'No pressure units implied']
        : this.mode === 'thermal'
          ? ['RELATIVE HEATING', '100%', '50%', '0%', 'Exposure heuristic']
          : ['EXPOSURE', 'EXPOSED', 'PARTIAL', 'SHIELDED', 'Freestream visibility'];
    this.legendEl.dataset.mode = this.mode;
    this.legendEl.replaceChildren();
    el('div', 'aero-lab-scale-title', this.legendEl, content[0]);
    const scale = el('div', 'aero-lab-scale-body', this.legendEl);
    el('div', 'aero-lab-scale-bar', scale);
    const labels = el('div', 'aero-lab-scale-labels', scale);
    el('span', '', labels, content[1]);
    el('span', '', labels, content[2]);
    el('span', '', labels, content[3]);
    el('p', 'aero-lab-scale-note', this.legendEl, content[4]);
  }

  private syncPauseButton(): void {
    this.pauseButton.textContent = this.paused ? '▶ RESUME AIRFLOW' : 'Ⅱ PAUSE AIRFLOW';
    this.pauseButton.setAttribute('aria-pressed', String(this.paused));
  }

  private closeWorker(): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.debounce = null;
    this.slowTimer = null;
    this.requestId++;
    this.worker?.terminate();
    this.worker = null;
  }

  private setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }
}
