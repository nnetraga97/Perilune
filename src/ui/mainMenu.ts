import type { SaveGame } from '../save/schema';
import { iconButton } from './icons';
import { el, injectUiStyles } from './kit';

export type MissionEntry = 'continue' | 'first-light' | 'sandbox';

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
      id: 'sandbox',
      eyebrow: 'OPEN PROGRAM',
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
  onSandbox(): void;
  onSaves(): void;
  onAccount(): void;
  onSettings(): void;
}

const actionLabels: Record<MissionEntry, string> = {
  continue: 'Continue Mission',
  'first-light': 'First Light tutorial',
  sandbox: 'Sandbox — just build and fly',
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
      'Build with care. Fly beyond Veyra. Bring them home.',
    );
    el('div', 'perilune-menu-build', this.root, 'VEYRA ORBITAL PROGRAM · DEVELOPMENT BUILD');

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

  private rebuildCommandDeck(): void {
    this.commandDeck.replaceChildren();
    for (const mission of menuMissions(this.continueSave)) {
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
        else this.callbacks.onSandbox();
      };
    }

    const utilities = el('div', 'perilune-menu-utilities', this.commandDeck);
    iconButton(utilities, 'save', 'Save & Load', () => this.callbacks.onSaves());
    iconButton(utilities, 'account', 'Account', () => this.callbacks.onAccount());
    iconButton(utilities, 'settings', 'Settings', () => this.callbacks.onSettings());
  }
}
