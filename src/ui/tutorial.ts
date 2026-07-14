/**
 * Interactive tutorial: "First Light" — build a rocket, reach orbit, come home.
 *
 * A sequence of steps, each with a completion condition evaluated against
 * the REAL game state every frame (no fake sim). Non-blocking: the player
 * can ignore or dismiss it at any time.
 */
import { GameState } from '../sim/state';
import { defOf } from '../sim/vessel';
import { apoapsisOf, periapsisOf, stateToElements } from '../core/orbit';
import type { Editor } from './editor';
import { injectUiStyles } from './kit';

export interface TutorialContext {
  game: GameState | null;
  editor: Editor;
  screen: 'menu' | 'editor' | 'flight';
}

interface TutorialStep {
  title: string;
  text: string;
  done(ctx: TutorialContext): boolean;
}

const STEPS: TutorialStep[] = [
  {
    title: 'Welcome to the Workshop',
    text: 'Every journey starts with a crew cabin. Open the PODS category on the left and place a Voyager Pod.',
    done: (ctx) => ctx.editor.craft.parts.some((p) => defOf(p).pod),
  },
  {
    title: 'Something to burn',
    text: 'Rockets are mostly propellant. From TANKS, attach a fuel tank below the pod (click the bottom attachment node).',
    done: (ctx) => ctx.editor.craft.parts.some((p) => (p.resources.propellant ?? 0) > 0),
  },
  {
    title: 'Something to burn it in',
    text: 'From ENGINES, attach an engine below the tank. The K-45 "Pike" is a dependable choice.',
    done: (ctx) => ctx.editor.craft.parts.some((p) => defOf(p).engine),
  },
  {
    title: 'The way back down',
    text: 'From UTILITY, place a Homecoming Chute on top of the pod. Your pilot will thank you later.',
    done: (ctx) => ctx.editor.craft.parts.some((p) => defOf(p).parachute),
  },
  {
    title: 'Set the staging',
    text: 'Press AUTO-STAGE on the right so the engine fires at launch and the chute arms for descent. Check the Δv readout — 3,400 m/s or more will reach orbit.',
    done: (ctx) => ctx.editor.craft.stages.length >= 1,
  },
  {
    title: 'Fly',
    text: 'Press LAUNCH. On the pad: hold Shift to throttle up, press SPACE to ignite. Climb straight up at first.',
    done: (ctx) => ctx.screen === 'flight' && (ctx.game?.active?.runtime.situation === 'flying' || ctx.game?.active?.runtime.situation === 'suborbital' || ctx.game?.active?.runtime.situation === 'orbit'),
  },
  {
    title: 'The gravity turn',
    text: 'Around 100 m/s, tip slightly east (D key) and follow the prograde marker ⊕ on the navball. Aim to leave the atmosphere at a shallow angle.',
    done: (ctx) => {
      const gv = ctx.game?.active;
      if (!gv) return false;
      const body = ctx.game!.bodyOf(gv);
      return gv.runtime.pos.length() - body.radius > 42_000;
    },
  },
  {
    title: 'Raise the far side',
    text: 'Watch the Ap readout: burn until apoapsis shows above 90 km, then cut throttle (X).',
    done: (ctx) => {
      const gv = ctx.game?.active;
      if (!gv) return false;
      const body = ctx.game!.bodyOf(gv);
      const el = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, ctx.game!.time);
      return el.e < 1 && apoapsisOf(el) - body.radius > 90_000;
    },
  },
  {
    title: 'Circularize',
    text: 'Coast to apoapsis (use time warp ▶▶), point prograde, and burn until periapsis also rises above 85 km. That is a stable orbit — you are a spacefarer.',
    done: (ctx) => {
      const gv = ctx.game?.active;
      if (!gv) return false;
      const body = ctx.game!.bodyOf(gv);
      const el = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, ctx.game!.time);
      return el.e < 1 && periapsisOf(el) - body.radius > 85_000 && gv.runtime.situation === 'orbit';
    },
  },
  {
    title: 'Science!',
    text: 'Press the SCIENCE button to record observations from orbit. Every new situation around every world has something to teach.',
    done: (ctx) => (ctx.game?.active?.runtime.scienceData.size ?? 0) > 0 || (ctx.game?.completedExperiments.size ?? 0) > 0,
  },
  {
    title: 'Come home',
    text: 'Point retrograde ⊖ and burn until periapsis drops below 30 km. Ride the atmosphere down — the chute arms with your last stage (SPACE).',
    done: (ctx) => {
      const s = ctx.game?.active?.runtime.situation;
      return s === 'landed' || s === 'splashed';
    },
  },
  {
    title: 'Homecoming',
    text: 'Press RECOVER to bring the crew and their science home. The Cooperative is very proud. Next stop: Palla — plan a transfer with a maneuver node in Map view (M).',
    done: (ctx) => ctx.game !== null && ctx.game.flags.recoveredOnce === true,
  },
];

export class Tutorial {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private textEl: HTMLElement;
  private progressEl: HTMLElement;
  private stepIndex = 0;
  private dismissed = false;
  active = false;

  constructor(uiRoot: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tut-box';
    this.root.innerHTML = '';
    injectUiStyles();
    this.progressEl = document.createElement('div');
    this.progressEl.className = 'tut-progress';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tut-title';
    this.textEl = document.createElement('div');
    this.textEl.className = 'tut-text';
    const actions = document.createElement('div');
    actions.className = 'tut-actions';
    const skip = document.createElement('button');
    skip.className = 'hud-btn';
    skip.textContent = 'Dismiss tutorial';
    skip.onclick = () => this.dismiss();
    actions.appendChild(skip);
    this.root.append(this.progressEl, this.titleEl, this.textEl, actions);
    uiRoot.appendChild(this.root);
    this.root.style.display = 'none';
  }

  start(): void {
    this.active = true;
    this.dismissed = false;
    this.stepIndex = 0;
    this.root.style.display = '';
    this.render();
  }

  dismiss(): void {
    this.dismissed = true;
    this.active = false;
    this.root.style.display = 'none';
  }

  get currentStep(): number {
    return this.stepIndex;
  }

  update(ctx: TutorialContext): void {
    if (!this.active || this.dismissed) return;
    const step = STEPS[this.stepIndex];
    if (!step) {
      this.dismiss();
      return;
    }
    if (step.done(ctx)) {
      this.stepIndex++;
      if (this.stepIndex >= STEPS.length) {
        this.progressEl.textContent = 'TUTORIAL COMPLETE';
        this.titleEl.textContent = 'Per aspera ad astra';
        this.textEl.textContent = 'You have flown the full loop: build, launch, orbit, return. The sky is no longer the limit.';
        setTimeout(() => this.dismiss(), 12_000);
        return;
      }
      this.render();
    }
  }

  private render(): void {
    const step = STEPS[this.stepIndex];
    this.progressEl.textContent = `FIRST LIGHT · STEP ${this.stepIndex + 1} / ${STEPS.length}`;
    this.titleEl.textContent = step.title;
    this.textEl.textContent = step.text;
  }
}
