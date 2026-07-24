import type { SaveGame } from '../save/schema';
import type { ArtemisIvChapter } from '../missions/artemisIv/session';
import { iconButton } from './icons';
import { el, injectUiStyles } from './kit';

export const ARTEMIS_IV_VISIBLE_QUALIFIER =
  'UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD';
export const DEFAULT_ARTEMIS_IV_MENU_ENABLED = false;

export type MissionEntry =
  | 'continue'
  | 'artemis-iv'
  | 'first-light'
  | 'exploration'
  | 'program'
  | 'sandbox';

export type ArtemisIvMenuState =
  | { status: 'new' }
  | { status: 'resume'; chapter: ArtemisIvChapter }
  | { status: 'complete' };

export type ArtemisIvMenuAction = 'start' | 'resume' | 'fly-again';
export type RestartableMission = 'artemis-iv' | 'first-light';

export interface MissionRestartAction {
  mission: RestartableMission;
  label: string;
  ariaLabel: string;
}

export interface MenuMissionOptions {
  artemisIvEnabled?: boolean;
  artemisIvState?: ArtemisIvMenuState;
}

export interface MenuMission {
  id: MissionEntry;
  eyebrow: string;
  title: string;
  detail: string;
  qualifier?: string;
  restart?: MissionRestartAction;
  primary: boolean;
}

function artemisIvMission(
  save: SaveGame | null,
  state: ArtemisIvMenuState,
): MenuMission {
  if (state.status === 'resume') {
    return {
      id: 'artemis-iv',
      eyebrow: 'CHAPTER CHECKPOINT',
      title: `RESUME ARTEMIS IV · CHAPTER ${state.chapter}`,
      detail: 'Resume begins at the chapter checkpoint',
      qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
      restart: {
        mission: 'artemis-iv',
        label: 'RESTART FROM CHAPTER 1',
        ariaLabel: 'Restart Artemis IV from Chapter 1',
      },
      primary: !save,
    };
  }
  if (state.status === 'complete') {
    return {
      id: 'artemis-iv',
      eyebrow: 'MISSION COMPLETE',
      title: 'ARTEMIS IV',
      detail: 'FLY AGAIN',
      qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
      primary: !save,
    };
  }
  return {
    id: 'artemis-iv',
    eyebrow: 'GUIDED LUNAR LANDING',
    title: 'ARTEMIS IV',
    detail: 'BEGIN MISSION',
    qualifier: ARTEMIS_IV_VISIBLE_QUALIFIER,
    primary: !save,
  };
}

export function menuMissions(
  save: SaveGame | null,
  options: Readonly<MenuMissionOptions> = {},
): readonly MenuMission[] {
  const artemisIvEnabled = options.artemisIvEnabled ?? DEFAULT_ARTEMIS_IV_MENU_ENABLED;
  const base: MenuMission[] = [
    {
      id: 'first-light',
      eyebrow: 'GUIDED',
      title: 'FIRST LIGHT',
      detail: 'Earth orbit to the Moon',
      restart: {
        mission: 'first-light',
        label: 'START OVER FROM LAUNCH',
        ariaLabel: 'Restart First Light from launch',
      },
      primary: !save && !artemisIvEnabled,
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
  if (artemisIvEnabled) {
    base.unshift(artemisIvMission(save, options.artemisIvState ?? { status: 'new' }));
  }
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
  onArtemisIv?(action: ArtemisIvMenuAction): Promise<void> | void;
  onFirstLight(): void;
  onRestart(mission: RestartableMission): void;
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
  'artemis-iv': 'Artemis IV guided lunar landing mission',
  'first-light': 'First Light tutorial',
  sandbox: 'Sandbox — just build and fly',
  exploration: 'Exploration — unlock technology with science',
  program: 'Space Program — funding, technology, and contracts',
};

export class MainMenu {
  readonly root: HTMLElement;
  private readonly commandDeck: HTMLElement;
  private continueSave: SaveGame | null = null;
  private readonly artemisIvEnabled: boolean;
  private artemisIvState: ArtemisIvMenuState;

  constructor(
    parent: HTMLElement,
    private readonly callbacks: MainMenuCallbacks,
    options: Readonly<MenuMissionOptions> = {},
  ) {
    this.artemisIvEnabled = options.artemisIvEnabled ?? DEFAULT_ARTEMIS_IV_MENU_ENABLED;
    this.artemisIvState = options.artemisIvState ?? { status: 'new' };
    if (this.artemisIvEnabled && !callbacks.onArtemisIv) {
      throw new Error('Artemis IV menu is enabled without an onArtemisIv callback.');
    }
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

  setArtemisIvState(state: ArtemisIvMenuState): void {
    this.artemisIvState = state;
    this.rebuildCommandDeck();
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  private rebuildCommandDeck(): void {
    this.commandDeck.replaceChildren();
    const missions = menuMissions(this.continueSave, {
      artemisIvEnabled: this.artemisIvEnabled,
      artemisIvState: this.artemisIvState,
    });
    this.commandDeck.style.setProperty('--mission-count', String(missions.length));
    this.commandDeck.classList.toggle(
      'perilune-command-deck-artemis',
      missions.some((mission) => mission.id === 'artemis-iv'),
    );
    for (const mission of missions) {
      const group = el('div', 'perilune-mission-group', this.commandDeck);
      const button = el(
        'button',
        `perilune-mission${mission.primary ? ' perilune-mission-primary' : ''}`,
        group,
      ) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('aria-label', actionLabels[mission.id]);
      el('span', 'perilune-mission-eyebrow', button, mission.eyebrow);
      el('span', 'perilune-mission-title', button, mission.title);
      el('span', 'perilune-mission-detail', button, mission.detail);
      if (mission.qualifier) {
        el('span', 'perilune-mission-qualifier', button, mission.qualifier);
      }
      button.onclick = () => {
        if (mission.id === 'continue') void this.callbacks.onContinue();
        else if (mission.id === 'artemis-iv') {
          const action: ArtemisIvMenuAction = this.artemisIvState.status === 'complete'
            ? 'fly-again'
            : this.artemisIvState.status === 'resume' ? 'resume' : 'start';
          void this.callbacks.onArtemisIv?.(action);
        }
        else if (mission.id === 'first-light') this.callbacks.onFirstLight();
        else if (mission.id === 'exploration') this.callbacks.onExploration();
        else if (mission.id === 'program') this.callbacks.onProgram();
        else this.callbacks.onSandbox();
      };
      if (mission.restart) {
        const restart = el(
          'button',
          'perilune-mission-restart',
          group,
          mission.restart.label,
        ) as HTMLButtonElement;
        restart.type = 'button';
        restart.setAttribute('aria-label', mission.restart.ariaLabel);
        restart.onclick = () => this.callbacks.onRestart(mission.restart!.mission);
      }
    }

    const utilities = el('div', 'perilune-menu-utilities', this.commandDeck);
    iconButton(utilities, 'save', 'Save & Load', () => this.callbacks.onSaves());
    iconButton(utilities, 'account', 'Account', () => this.callbacks.onAccount());
    iconButton(utilities, 'settings', 'Settings', () => this.callbacks.onSettings());
  }
}
