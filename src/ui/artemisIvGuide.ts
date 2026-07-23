import type { ArtemisIvGuideViewModel } from '../missions/artemisIv/guide';
import { injectUiStyles } from './kit';

export interface ArtemisIvGuideContextualAction {
  id: string;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export interface ArtemisIvGuideReadout {
  label: string;
  value: string;
  tone?: 'neutral' | 'caution' | 'good';
}

export interface ArtemisIvGuidePresentation {
  contextualAction?: Readonly<ArtemisIvGuideContextualAction> | null;
  readouts?: readonly Readonly<ArtemisIvGuideReadout>[];
}

export interface ArtemisIvGuideCallbacks {
  onContinue(): void;
  onContextualAction(action: Readonly<ArtemisIvGuideContextualAction>): void;
  onRetryChapter(): void;
  onSkipChapter(): void;
  onExit(): void;
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

interface GuideDragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

/** Mission-specific presentation for the Artemis IV chapter guide. */
export class ArtemisIvGuide {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly missionLabelEl: HTMLElement;
  private readonly progressLabelEl: HTMLElement;
  private readonly accuracyEl: HTMLElement;
  private readonly progressRailEl: HTMLElement;
  private readonly chapterTitleEl: HTMLElement;
  private readonly kindEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private readonly nextTextEl: HTMLElement;
  private readonly readoutsEl: HTMLElement;
  private readonly confirmationEl: HTMLElement;
  private readonly confirmationMessageEl: HTMLElement;
  private readonly primaryBtn: HTMLButtonElement;
  private readonly retryBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly exitBtn: HTMLButtonElement;
  private currentContextualAction: Readonly<ArtemisIvGuideContextualAction> | null = null;
  private progressRenderKey = '';
  private readoutsRenderKey = '';
  private drag: GuideDragState | null = null;

  constructor(uiRoot: HTMLElement, private readonly callbacks: ArtemisIvGuideCallbacks) {
    injectUiStyles();
    this.root = document.createElement('aside');
    this.root.className = 'artiv-guide';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Artemis IV mission guide');

    this.headerEl = document.createElement('header');
    this.headerEl.className = 'artiv-guide-header';
    this.headerEl.tabIndex = 0;
    this.headerEl.title = 'Drag to move mission guide; use arrow keys for precise movement';
    this.headerEl.setAttribute(
      'aria-label',
      'Move Artemis IV mission guide. Use arrow keys to move.',
    );
    const headerCopy = document.createElement('div');
    headerCopy.className = 'artiv-guide-header-copy';
    this.missionLabelEl = document.createElement('div');
    this.missionLabelEl.className = 'artiv-guide-mission';
    this.progressLabelEl = document.createElement('div');
    this.progressLabelEl.className = 'artiv-guide-progress';
    headerCopy.append(this.missionLabelEl, this.progressLabelEl);
    const mode = document.createElement('span');
    mode.className = 'artiv-guide-mode';
    mode.textContent = 'MOVE';
    this.headerEl.append(headerCopy, mode);

    this.accuracyEl = document.createElement('div');
    this.accuracyEl.className = 'artiv-guide-accuracy';
    this.accuracyEl.setAttribute('aria-label', 'Visual accuracy note');

    this.progressRailEl = document.createElement('div');
    this.progressRailEl.className = 'artiv-guide-rail';
    this.progressRailEl.setAttribute('role', 'progressbar');
    this.progressRailEl.setAttribute('aria-label', 'Artemis IV chapter progress');

    this.chapterTitleEl = document.createElement('div');
    this.chapterTitleEl.className = 'artiv-guide-chapter-title';

    const heading = document.createElement('div');
    heading.className = 'artiv-guide-step-heading';
    this.kindEl = document.createElement('span');
    this.kindEl.className = 'artiv-guide-step-kind';
    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'artiv-guide-title';
    heading.append(this.kindEl, this.titleEl);

    this.nextEl = document.createElement('div');
    this.nextEl.className = 'artiv-guide-next';
    const nextLabel = document.createElement('div');
    nextLabel.className = 'artiv-guide-next-label';
    nextLabel.textContent = 'DO NEXT';
    this.nextTextEl = document.createElement('div');
    this.nextTextEl.className = 'artiv-guide-next-text';
    this.nextEl.append(nextLabel, this.nextTextEl);

    this.readoutsEl = document.createElement('dl');
    this.readoutsEl.className = 'artiv-guide-readouts';
    this.readoutsEl.setAttribute('aria-label', 'Live mission measurements');
    this.readoutsEl.hidden = true;

    this.confirmationEl = document.createElement('div');
    this.confirmationEl.className = 'artiv-guide-confirmation';
    this.confirmationEl.setAttribute('role', 'status');
    this.confirmationEl.setAttribute('aria-live', 'polite');
    const confirmationLabel = document.createElement('span');
    confirmationLabel.className = 'artiv-guide-confirmation-label';
    confirmationLabel.textContent = 'STEP COMPLETE';
    this.confirmationMessageEl = document.createElement('span');
    this.confirmationMessageEl.className = 'artiv-guide-confirmation-message';
    this.confirmationEl.append(confirmationLabel, this.confirmationMessageEl);
    this.confirmationEl.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'artiv-guide-actions';
    const primaryActions = document.createElement('div');
    primaryActions.className = 'artiv-guide-primary-actions';
    this.primaryBtn = document.createElement('button');
    this.primaryBtn.className = 'hud-btn artiv-guide-primary';
    this.primaryBtn.onclick = () => this.activatePrimary();
    primaryActions.appendChild(this.primaryBtn);

    const secondaryActions = document.createElement('div');
    secondaryActions.className = 'artiv-guide-secondary-actions';
    this.retryBtn = document.createElement('button');
    this.retryBtn.className = 'hud-btn artiv-guide-secondary-action';
    this.retryBtn.textContent = 'Retry chapter';
    this.retryBtn.setAttribute('aria-label', 'Retry Artemis IV chapter');
    this.retryBtn.onclick = () => this.callbacks.onRetryChapter();
    this.skipBtn = document.createElement('button');
    this.skipBtn.className = 'hud-btn artiv-guide-secondary-action artiv-guide-skip';
    this.skipBtn.textContent = 'Skip chapter';
    this.skipBtn.setAttribute('aria-label', 'Skip Artemis IV chapter');
    this.skipBtn.onclick = () => this.callbacks.onSkipChapter();
    this.exitBtn = document.createElement('button');
    this.exitBtn.className = 'hud-btn artiv-guide-secondary-action';
    this.exitBtn.textContent = 'Exit mission';
    this.exitBtn.setAttribute('aria-label', 'Exit Artemis IV mission');
    this.exitBtn.onclick = () => this.callbacks.onExit();
    secondaryActions.append(this.retryBtn, this.skipBtn, this.exitBtn);
    actions.append(primaryActions, secondaryActions);

    this.root.append(
      this.headerEl,
      this.accuracyEl,
      this.progressRailEl,
      this.chapterTitleEl,
      heading,
      this.nextEl,
      this.readoutsEl,
      this.confirmationEl,
      actions,
    );
    uiRoot.appendChild(this.root);

    this.headerEl.addEventListener('pointerdown', (event) => this.beginDrag(event));
    this.headerEl.addEventListener('pointermove', (event) => this.moveDrag(event));
    this.headerEl.addEventListener('pointerup', (event) => this.endDrag(event));
    this.headerEl.addEventListener('pointercancel', (event) => this.endDrag(event));
    this.headerEl.addEventListener('keydown', (event) => this.moveWithKeyboard(event));
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  update(
    viewModel: Readonly<ArtemisIvGuideViewModel>,
    presentation: Readonly<ArtemisIvGuidePresentation> = {},
  ): void {
    const complete = viewModel.kind === null;
    const confirming = viewModel.successMessage !== null;
    this.root.dataset.stepKind = viewModel.kind ?? 'complete';
    this.root.classList.toggle('artiv-guide-step-complete', confirming || complete);
    this.root.dataset.confirmationRemainingMs = String(viewModel.confirmationRemainingMs);
    setText(this.missionLabelEl, viewModel.missionLabel);
    setText(
      this.progressLabelEl,
      `CHAPTER ${viewModel.chapter} · STEP ${viewModel.stepNumber} OF ${viewModel.stepCount}`,
    );
    setText(this.accuracyEl, viewModel.accuracyLabel);
    setText(this.chapterTitleEl, viewModel.chapterTitle);
    setText(this.skipBtn, viewModel.chapter === 10 ? 'Finish from checkpoint' : 'Skip chapter');
    this.skipBtn.setAttribute(
      'aria-label',
      viewModel.chapter === 10 ? 'Finish Artemis IV from the chapter checkpoint' : `Skip Artemis IV chapter ${viewModel.chapter}`,
    );
    setText(this.kindEl, complete ? 'COMPLETE' : viewModel.kind.toUpperCase());
    setText(this.titleEl, viewModel.title);
    setText(this.nextTextEl, viewModel.doNext);
    this.nextEl.hidden = viewModel.doNext.length === 0;

    this.confirmationEl.hidden = !confirming;
    setText(this.confirmationMessageEl, viewModel.successMessage ?? '');
    this.renderReadouts(presentation.readouts ?? []);
    this.renderProgress(viewModel, confirming, complete);
    this.renderPrimary(viewModel, presentation.contextualAction ?? null, confirming);
  }

  private activatePrimary(): void {
    if (this.primaryBtn.hidden || this.primaryBtn.disabled) return;
    if (this.currentContextualAction) this.callbacks.onContextualAction(this.currentContextualAction);
    else this.callbacks.onContinue();
  }

  private renderPrimary(
    viewModel: Readonly<ArtemisIvGuideViewModel>,
    contextualAction: Readonly<ArtemisIvGuideContextualAction> | null,
    confirming: boolean,
  ): void {
    this.currentContextualAction = contextualAction;
    const action = contextualAction ?? viewModel.primaryAction;
    this.primaryBtn.hidden = confirming || action === null;
    if (!action) return;
    this.primaryBtn.textContent = action.label;
    this.primaryBtn.disabled = 'disabled' in action && action.disabled === true;
    this.primaryBtn.setAttribute(
      'aria-label',
      'ariaLabel' in action && action.ariaLabel ? action.ariaLabel : action.label,
    );
  }

  private renderProgress(
    viewModel: Readonly<ArtemisIvGuideViewModel>,
    confirming: boolean,
    complete: boolean,
  ): void {
    const renderKey = `${viewModel.stepNumber}/${viewModel.stepCount}/${confirming}/${complete}`;
    if (renderKey === this.progressRenderKey) return;
    this.progressRenderKey = renderKey;
    this.progressRailEl.replaceChildren();
    this.progressRailEl.setAttribute('aria-valuemin', '1');
    this.progressRailEl.setAttribute('aria-valuemax', String(viewModel.stepCount));
    this.progressRailEl.setAttribute('aria-valuenow', String(viewModel.stepNumber));
    this.progressRailEl.setAttribute(
      'aria-valuetext',
      complete
        ? `${viewModel.stepCount} of ${viewModel.stepCount} steps complete`
        : `Step ${viewModel.stepNumber} of ${viewModel.stepCount}`,
    );
    for (let index = 0; index < viewModel.stepCount; index++) {
      const segment = document.createElement('span');
      segment.className = 'artiv-guide-progress-segment';
      segment.classList.toggle(
        'is-complete',
        complete || index < viewModel.stepNumber - 1 || (confirming && index === viewModel.stepNumber - 1),
      );
      segment.classList.toggle('is-current', !complete && !confirming && index === viewModel.stepNumber - 1);
      segment.setAttribute('aria-hidden', 'true');
      this.progressRailEl.appendChild(segment);
    }
  }

  private renderReadouts(readouts: readonly Readonly<ArtemisIvGuideReadout>[]): void {
    const renderKey = JSON.stringify(readouts);
    if (renderKey === this.readoutsRenderKey) return;
    this.readoutsRenderKey = renderKey;
    this.readoutsEl.replaceChildren();
    this.readoutsEl.hidden = readouts.length === 0;
    for (const readout of readouts) {
      const row = document.createElement('div');
      row.className = 'artiv-guide-readout';
      row.dataset.tone = readout.tone ?? 'neutral';
      const label = document.createElement('dt');
      label.textContent = readout.label;
      const value = document.createElement('dd');
      value.textContent = readout.value;
      row.append(label, value);
      this.readoutsEl.appendChild(row);
    }
  }

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const rect = this.root.getBoundingClientRect();
    this.root.style.width = `${rect.width}px`;
    this.root.style.right = 'auto';
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${rect.top}px`;
    this.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    this.headerEl.setPointerCapture(event.pointerId);
    this.root.classList.add('dragging');
    event.preventDefault();
  }

  private moveDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.placeAt(event.clientX - this.drag.offsetX, event.clientY - this.drag.offsetY);
  }

  private endDrag(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (this.headerEl.hasPointerCapture(event.pointerId)) {
      this.headerEl.releasePointerCapture(event.pointerId);
    }
    this.drag = null;
    this.root.classList.remove('dragging');
  }

  private moveWithKeyboard(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const movement: Record<string, readonly [number, number]> = {
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
      ArrowDown: [0, delta],
    };
    const move = movement[event.key];
    if (!move) return;
    const rect = this.root.getBoundingClientRect();
    this.root.style.width = `${rect.width}px`;
    this.root.style.right = 'auto';
    this.placeAt(rect.left + move[0], rect.top + move[1]);
    event.preventDefault();
  }

  private placeAt(left: number, top: number): void {
    const rect = this.root.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    this.root.style.left = `${Math.max(8, Math.min(maxLeft, left))}px`;
    this.root.style.top = `${Math.max(8, Math.min(maxTop, top))}px`;
  }
}
