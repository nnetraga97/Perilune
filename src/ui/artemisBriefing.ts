import { el, injectUiStyles } from './kit';

export interface ArtemisBriefingPhase {
  readonly title: string;
  readonly detail: string;
  readonly contextOnly?: boolean;
}

export interface ArtemisBriefingSource {
  readonly label: string;
  readonly url: string;
}

export interface ArtemisBriefingContent {
  readonly objective: string;
  readonly phases: readonly ArtemisBriefingPhase[];
  readonly sources: readonly ArtemisBriefingSource[];
  readonly fidelityNote: string;
}

export interface ArtemisBriefingCallbacks {
  onBegin(): Promise<void> | void;
  onBack(): void;
}

/** Full-screen, save-independent entry briefing for the Artemis replay. */
export class ArtemisBriefing {
  readonly root: HTMLElement;
  private readonly beginButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private busy = false;

  constructor(
    parent: HTMLElement,
    content: ArtemisBriefingContent,
    private readonly callbacks: ArtemisBriefingCallbacks,
  ) {
    injectUiStyles();
    this.root = el('section', 'artemis-briefing', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-labelledby', 'artemis-briefing-title');

    const veil = el('div', 'artemis-briefing-veil', this.root);
    veil.setAttribute('aria-hidden', 'true');
    const shell = el('div', 'artemis-briefing-shell', this.root);
    const heading = el('header', 'artemis-briefing-heading', shell);
    el('div', 'artemis-kicker', heading, 'MISSION REPLAY · LUNAR GATEWAY');
    const title = el('h1', 'artemis-briefing-title', heading, 'ARTEMIS IV');
    title.id = 'artemis-briefing-title';
    el('p', 'artemis-briefing-objective', heading, content.objective);

    const body = el('div', 'artemis-briefing-body', shell);
    const overview = el('section', 'artemis-briefing-overview', body);
    el('h2', 'artemis-section-title', overview, 'FLIGHT PLAN');
    const phases = el('ol', 'artemis-phase-overview', overview);
    content.phases.forEach((phase, index) => {
      const item = el('li', `artemis-phase-overview-item${phase.contextOnly ? ' context-only' : ''}`, phases);
      el('span', 'artemis-phase-number', item, String(index + 1).padStart(2, '0'));
      const copy = el('span', 'artemis-phase-copy', item);
      el('strong', '', copy, phase.title);
      el('span', '', copy, phase.detail);
      if (phase.contextOnly) el('em', '', item, 'CONTEXT');
    });

    const notes = el('aside', 'artemis-briefing-notes', body);
    el('h2', 'artemis-section-title', notes, 'MISSION FIDELITY');
    el('p', 'artemis-fidelity-copy', notes, content.fidelityNote);
    const legend = el('dl', 'artemis-fidelity-legend', notes);
    for (const [term, detail] of [
      ['SOURCE-BACKED', 'Published mission facts'],
      ['REFERENCE ORBIT', 'NASA/JPL idealized Gateway NRHO'],
      ['REPRESENTATIVE', 'Authored approach choreography'],
      ['PROXY VISUAL', 'Temporary spacecraft geometry'],
    ] as const) {
      el('dt', '', legend, term);
      el('dd', '', legend, detail);
    }
    const sourceDetails = el('details', 'artemis-sources', notes) as HTMLDetailsElement;
    el('summary', '', sourceDetails, 'Sources & assumptions');
    const sourceList = el('ul', '', sourceDetails);
    for (const source of content.sources) {
      const item = el('li', '', sourceList);
      const anchor = el('a', '', item, source.label) as HTMLAnchorElement;
      anchor.href = source.url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
    }

    this.status = el('p', 'artemis-briefing-status', shell);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');

    const actions = el('div', 'artemis-briefing-actions', shell);
    this.backButton = el('button', 'artemis-action secondary', actions, 'Back') as HTMLButtonElement;
    this.backButton.type = 'button';
    this.backButton.addEventListener('click', () => {
      this.callbacks.onBack();
    });
    this.beginButton = el('button', 'artemis-action primary', actions, 'Begin Replay') as HTMLButtonElement;
    this.beginButton.type = 'button';
    this.beginButton.addEventListener('click', () => void this.begin());
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (!visible) {
      this.setPreparing(false);
      this.status.textContent = '';
      return;
    }
    requestAnimationFrame(() => this.beginButton.focus());
  }

  setPreparing(preparing: boolean): void {
    this.busy = preparing;
    this.beginButton.disabled = preparing;
    this.backButton.disabled = false;
    this.beginButton.textContent = preparing ? 'Preparing lunar scene…' : 'Begin Replay';
    this.root.setAttribute('aria-busy', String(preparing));
    if (preparing) this.status.textContent = 'Preparing the Moon, reference orbit, and mission timeline.';
  }

  showError(message: string): void {
    this.setPreparing(false);
    this.status.textContent = message;
    this.status.classList.add('error');
    this.beginButton.focus();
  }

  private async begin(): Promise<void> {
    if (this.busy) return;
    this.status.classList.remove('error');
    this.setPreparing(true);
    try {
      await this.callbacks.onBegin();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not prepare the mission replay.');
    }
  }
}
