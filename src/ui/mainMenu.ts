import type { SaveGame } from '../save/schema';
import { iconButton } from './icons';
import { el, injectUiStyles } from './kit';

export type MissionEntry = 'continue' | 'first-light' | 'artemis-iv' | 'exploration' | 'program' | 'sandbox';

export interface MenuMission {
  id: MissionEntry;
  eyebrow: string;
  title: string;
  detail: string;
  primary: boolean;
}

export function menuMissions(save: SaveGame | null): readonly MenuMission[] {
  const base: MenuMission[] = [
    {
      id: 'first-light',
      eyebrow: 'GUIDED',
      title: 'FIRST LIGHT',
      detail: 'Learn the program',
      primary: !save,
    },
    {
      id: 'artemis-iv',
      eyebrow: 'MISSION REPLAY',
      title: 'ARTEMIS IV',
      detail: 'Deliver I-Hab to Gateway',
      primary: false,
    },
    {
      id: 'exploration',
      eyebrow: 'DISCOVERY',
      title: 'EXPLORATION',
      detail: 'Recover science · unlock technology',
      primary: false,
    },
    {
      id: 'program',
      eyebrow: 'CAREER',
      title: 'SPACE PROGRAM',
      detail: 'Balance funding · fulfill contracts',
      primary: false,
    },
    {
      id: 'sandbox',
      eyebrow: 'UNRESTRICTED',
      title: 'SANDBOX',
      detail: 'Build and fly freely',
      primary: false,
    },
  ];
  if (!save) return base;

  const activeName = save.vessels.find((vessel) => vessel.id === save.activeVesselId)?.name
    ?? save.vessels[0]?.name
    ?? save.label;
  return [
    {
      id: 'continue',
      eyebrow: 'LAST FLIGHT',
      title: 'CONTINUE MISSION',
      detail: `${activeName} · UT ${Math.max(0, Math.floor(save.time))}s`,
      primary: true,
    },
    ...base,
  ];
}

export interface MainMenuCallbacks {
  onContinue(): Promise<void> | void;
  onFirstLight(): void;
  onArtemisIV(): void;
  onSandbox(): void;
  onExploration(): void;
  onProgram(): void;
  onSaves(): void;
  onAccount(): void;
  onSettings(): void;
}

export interface ContinueSaveSource {
  read(slot: 'auto'): Promise<SaveGame | null>;
  subscribe(listener: () => void): () => void;
}

export interface ContinueSaveTarget {
  setContinueSave(save: SaveGame | null): void;
}

export function bindMenuContinueSave(
  source: ContinueSaveSource,
  target: ContinueSaveTarget,
): () => void {
  let disposed = false;
  let generation = 0;
  const refresh = (): void => {
    const requestGeneration = ++generation;
    void source.read('auto').then((save) => {
      if (!disposed && requestGeneration === generation) target.setContinueSave(save);
    }, () => {
      // Preserve the last known menu state; a later source event will retry the read.
    });
  };
  const unsubscribe = source.subscribe(refresh);
  refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    unsubscribe();
  };
}

const actionLabels: Record<MissionEntry, string> = {
  continue: 'Continue Mission',
  'first-light': 'First Light tutorial',
  'artemis-iv': 'Artemis IV mission replay',
  sandbox: 'Sandbox — just build and fly',
  exploration: 'Exploration — unlock technology with science',
  program: 'Space Program — funding, technology, and contracts',
};

export class MainMenu {
  readonly root: HTMLElement;
  private readonly commandDeck: HTMLElement;
  private continueSave: SaveGame | null = null;

  constructor(parent: HTMLElement, private readonly callbacks: MainMenuCallbacks) {
    injectUiStyles();
    this.root = el('section', 'perilune-menu', parent);
    this.root.setAttribute('aria-labelledby', 'perilune-menu-title');
    el('div', 'perilune-menu-vignette', this.root).setAttribute('aria-hidden', 'true');

    const masthead = el('header', 'perilune-menu-masthead', this.root);
    el(
      'div',
      'perilune-menu-eyebrow',
      masthead,
      'A SPACE PROGRAM OF THE SKYWARD COOPERATIVE',
    );
    const logo = el('h1', 'perilune-menu-logo', masthead, 'PERILUNE');
    logo.id = 'perilune-menu-title';
    el(
      'div',
      'perilune-menu-tagline',
      masthead,
      'Build with care. Fly beyond home. Bring them back.',
    );
    el('div', 'perilune-menu-build', this.root, 'ORBITAL FLIGHT PROGRAM · DEVELOPMENT BUILD');

    this.commandDeck = el('nav', 'perilune-command-deck', this.root);
    this.commandDeck.setAttribute('aria-label', 'Mission and utility actions');
    this.rebuildCommandDeck();
  }

  setContinueSave(save: SaveGame | null): void {
    this.continueSave = save;
    this.rebuildCommandDeck();
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  focusMission(mission: MissionEntry): void {
    const label = actionLabels[mission];
    requestAnimationFrame(() => {
      this.commandDeck.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.focus();
    });
  }

  private rebuildCommandDeck(): void {
    this.commandDeck.replaceChildren();
    const missions = menuMissions(this.continueSave);
    this.commandDeck.style.setProperty('--mission-count', String(missions.length));
    for (const mission of missions) {
      const button = el(
        'button',
        `perilune-mission${mission.primary ? ' perilune-mission-primary' : ''}`,
        this.commandDeck,
      ) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', actionLabels[mission.id]);
      el('span', 'perilune-mission-eyebrow', button, mission.eyebrow);
      el('span', 'perilune-mission-title', button, mission.title);
      el('span', 'perilune-mission-detail', button, mission.detail);
      button.onclick = () => {
        if (mission.id === 'continue') void this.callbacks.onContinue();
        else if (mission.id === 'first-light') this.callbacks.onFirstLight();
        else if (mission.id === 'artemis-iv') this.callbacks.onArtemisIV();
        else if (mission.id === 'exploration') this.callbacks.onExploration();
        else if (mission.id === 'program') this.callbacks.onProgram();
        else this.callbacks.onSandbox();
      };
    }

    const utilities = el('div', 'perilune-menu-utilities', this.commandDeck);
    iconButton(utilities, 'save', 'Save & Load', () => this.callbacks.onSaves());
    iconButton(utilities, 'account', 'Account', () => this.callbacks.onAccount());
    iconButton(utilities, 'settings', 'Settings', () => this.callbacks.onSettings());
  }
}
