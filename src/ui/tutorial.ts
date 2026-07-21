/**
 * Interactive tutorial: "First Light" — use a prepared Earth vehicle to learn
 * how altitude, horizontal velocity, apoapsis, periapsis, and burn timing make
 * an orbit in the real Sol flight model.
 */
import { apoapsisOf, periapsisOf, stateToElements } from '../core/orbit';
import { maxThrust } from '../sim/flight';
import { GameState } from '../sim/state';
import type { Editor } from './editor';
import { injectUiStyles, spotlight } from './kit';

export interface TutorialContext {
  game: GameState | null;
  editor: Editor;
  screen: 'menu' | 'editor' | 'flight';
  mapVisible: boolean;
  maneuverPlanned: boolean;
  maneuverAutoExecution: boolean;
  warpRate: number;
}

export type TutorialPhase = 'earth' | 'moon';

interface TutorialStep {
  title: string;
  text: string;
  /** CSS selector of the control to spotlight while this step is active. */
  highlight?: string;
  done(ctx: TutorialContext): boolean;
}

function altitude(ctx: TutorialContext): number {
  const vessel = ctx.game?.active;
  if (!vessel) return -Infinity;
  return vessel.runtime.pos.length() - ctx.game!.bodyOf(vessel).radius;
}

function orbitalAltitudes(ctx: TutorialContext): {
  apoapsis: number;
  periapsis: number;
} | null {
  const vessel = ctx.game?.active;
  if (!vessel) return null;
  const body = ctx.game!.bodyOf(vessel);
  const elements = stateToElements(body.mu, vessel.runtime.pos, vessel.runtime.vel, ctx.game!.time);
  if (!(elements.e < 1)) return null;
  return {
    apoapsis: apoapsisOf(elements) - body.radius,
    periapsis: periapsisOf(elements) - body.radius,
  };
}

function verticalSpeed(ctx: TutorialContext): number {
  const vessel = ctx.game?.active;
  if (!vessel) return 0;
  return vessel.runtime.vel.dot(vessel.runtime.pos.clone().normalize());
}

function boostersEmpty(ctx: TutorialContext): boolean {
  const parts = ctx.game?.active?.runtime.craft.parts.filter((part) => part.defId === 'srb-torch') ?? [];
  return parts.length > 0 && parts.every((part) => (part.resources.solidFuel ?? 0) <= 1e-6);
}

function availableThrust(ctx: TutorialContext): number {
  const vessel = ctx.game?.active;
  if (!vessel) return 0;
  const body = ctx.game!.bodyOf(vessel);
  return maxThrust(
    vessel.runtime,
    body.pressureAt(altitude(ctx)),
    ctx.game!.flightTuning,
    body.def.atmosphere?.seaLevelPressure,
  );
}

function engineActivated(ctx: TutorialContext, defId: string): boolean {
  return Boolean(ctx.game?.active?.runtime.craft.parts.some((part) => (
    part.defId === defId && part.activated
  )));
}

function activeBodyId(ctx: TutorialContext): string | null {
  return ctx.game?.active?.runtime.bodyId ?? null;
}

function isStableLowLunarOrbit(ctx: TutorialContext): boolean {
  if (activeBodyId(ctx) !== 'moon' || ctx.game?.active?.runtime.situation !== 'orbit') return false;
  const orbit = orbitalAltitudes(ctx);
  return orbit !== null
    && orbit.periapsis >= 30_000
    && orbit.apoapsis <= 400_000
    && orbit.apoapsis - orbit.periapsis <= 120_000;
}

const EARTH_STEPS: TutorialStep[] = [
  {
    title: 'The mission: make an orbit',
    highlight: '.ed-launch',
    text: 'Orbit is not just going high—it is moving sideways fast enough to keep falling around Earth. Your staged First Light vehicle is ready. Press LAUNCH.',
    done: (ctx) => ctx.screen === 'flight' && Boolean(ctx.game?.active),
  },
  {
    title: 'Set full throttle',
    highlight: '.hud-throttle-range',
    text: 'Press Z, hold Shift, or drag the throttle beside the navball to 100%. Throttle controls engine thrust; staging decides which engines and separators fire.',
    done: (ctx) => (ctx.game?.active?.runtime.controls.throttle ?? 0) >= 0.99,
  },
  {
    title: 'Engage launch guidance',
    highlight: '[data-mode="ascent"]',
    text: 'Select LAUNCH GUIDANCE (↑). It will rise vertically through dense air, then gradually pitch east to build the horizontal speed an orbit needs.',
    done: (ctx) => ctx.game?.active?.runtime.sas === 'ascent',
  },
  {
    title: 'Commit to flight',
    highlight: '.hud-stage-btn',
    text: 'Press SPACE or STAGE once. The center engine and four boosters ignite together. Watch altitude, speed, and the Q air-load gauge during ascent.',
    done: (ctx) => (ctx.game?.active?.runtime.currentStage ?? 0) >= 1,
  },
  {
    title: 'Watch the gravity turn',
    text: 'The rocket starts upright, then leans east. This gravity turn trades vertical climb for orbital speed without fighting the airflow. Wait for the side boosters to burn out.',
    done: (ctx) => (ctx.game?.active?.runtime.currentStage ?? 0) >= 2 || boostersEmpty(ctx),
  },
  {
    title: 'Drop the empty boosters',
    highlight: '.hud-stage-btn',
    text: 'Keep the core engine burning and press STAGE to release the four spent boosters. Empty hardware is dead weight; shedding it improves the acceleration of everything that remains.',
    done: (ctx) => Boolean(ctx.game?.active)
      && !ctx.game!.active!.runtime.craft.parts.some((part) => part.defId === 'srb-torch'),
  },
  {
    title: 'Carry the turn through 80 km',
    text: 'Keep full throttle and launch guidance engaged. The core is now trading vertical climb for sideways velocity. Continue until altitude passes 80 km.',
    done: (ctx) => altitude(ctx) >= 80_000,
  },
  {
    title: 'Stage the core',
    highlight: '.hud-stage-btn',
    text: 'Keep full throttle and press STAGE. The heavy core separates and the upper-stage engine ignites immediately. The core still has reserve fuel, but staging now saves more mass than that fuel is worth.',
    done: (ctx) => {
      const mules = ctx.game?.active?.runtime.craft.parts.filter((part) => part.defId === 'eng-mule') ?? [];
      return mules.length === 1 && Boolean(mules[0].activated);
    },
  },
  {
    title: 'Ride the upper stage',
    text: 'Above most of the atmosphere, launch guidance turns nearly horizontal. Watch Ap and Pe while the vehicle accelerates sideways: Ap is the high point and Pe is the low point. Use up to 4× physics warp if desired and wait for thrust to end.',
    done: (ctx) => availableThrust(ctx) <= 1,
  },
  {
    title: 'Stage the insertion engine',
    highlight: '.hud-stage-btn',
    text: 'Leave the throttle at full and press STAGE. The empty upper stage falls away and the Pike insertion engine takes over the horizontal burn that raises Pe.',
    done: (ctx) => engineActivated(ctx, 'eng-pike')
      && !(ctx.game?.active?.runtime.craft.parts.some((part) => part.defId === 'eng-mule') ?? true),
  },
  {
    title: 'Insertion-stage burnout',
    text: 'The horizontal burn raises Pe—the opposite side of the path—out of Earth. Wait until Pike thrust reaches zero; the reserved lunar stage will finish the last part of Earth insertion.',
    done: (ctx) => availableThrust(ctx) <= 1,
  },
  {
    title: 'Expose the lunar stage',
    highlight: '.hud-stage-btn',
    text: 'Keep full throttle and press STAGE. The insertion stage falls away and the efficient Ember engine ignites to finish the orbit.',
    done: (ctx) => engineActivated(ctx, 'eng-ember')
      && !(ctx.game?.active?.runtime.craft.parts.some((part) => part.defId === 'eng-pike') ?? true),
  },
  {
    title: 'Raise periapsis',
    highlight: '.hud-throttle-range',
    text: 'Throttle up and watch Pe rise. When Pe exceeds 100 km, the entire path is above Earth’s atmosphere and gravity bends it into a persistent orbit.',
    done: (ctx) => {
      const orbit = orbitalAltitudes(ctx);
      return orbit !== null && orbit.periapsis >= 100_000
        && ctx.game?.active?.runtime.situation === 'orbit';
    },
  },
  {
    title: 'Orbital insertion cutoff',
    highlight: '.hud-throttle-range',
    text: 'Press X now to stop the burn. Every second of thrust keeps reshaping the orbit; cutoff is as important as ignition. With both Ap and Pe above the atmosphere, this path will persist.',
    done: (ctx) => (ctx.game?.active?.runtime.controls.throttle ?? 1) <= 0.01,
  },
  {
    title: 'See what you built',
    highlight: '[data-action="map"]',
    text: 'Press M or MAP. The closed path is your orbit: velocity carries you forward while gravity continuously bends that motion around Earth.',
    done: (ctx) => ctx.mapVisible,
  },
];

const MOON_STEPS: TutorialStep[] = [
  {
    title: 'Read the Moon transfer node',
    highlight: '[data-action="maneuver-auto"]',
    text: 'The planned node stores when to burn and a three-dimensional Δv vector. Its trajectory has been checked for a Moon encounter. Press AUTO so the flight computer can orient and execute while you study the result.',
    done: (ctx) => ctx.maneuverPlanned && ctx.maneuverAutoExecution,
  },
  {
    title: 'Warp to the burn',
    highlight: '[data-action="maneuver-warp"]',
    text: 'Press ≫ in the maneuver planner. Time warp stops before ignition, leaving time for the spacecraft to turn toward the node vector.',
    done: (ctx) => ctx.warpRate > 1,
  },
  {
    title: 'Execute trans-lunar injection',
    text: 'The burn adds energy and stretches the Earth orbit until it intersects the Moon’s path. AUTO controls attitude and cutoff, then adds a short correction if the long finite burn shifted the lunar approach. Use up to 4× physics warp and wait until no maneuver remains.',
    done: (ctx) => !ctx.maneuverPlanned && activeBodyId(ctx) === 'earth',
  },
  {
    title: 'Coast to the Moon',
    highlight: '.hud-warp-btns .hud-btn:last-child',
    text: 'With the engine off, momentum carries First Light outward while Earth continuously slows it. Increase time warp and wait until the Moon becomes the active sphere of influence.',
    done: (ctx) => activeBodyId(ctx) === 'moon',
  },
  {
    title: 'Approach lunar periapsis',
    highlight: '.hud-warp-btns .hud-btn:last-child',
    text: 'You are now falling past the Moon on an open flyby. Continue warping, then return to 1× below 500 km while altitude is still decreasing. This low point is where capture is most efficient.',
    done: (ctx) => activeBodyId(ctx) === 'moon'
      && altitude(ctx) <= 500_000 && verticalSpeed(ctx) < 0,
  },
  {
    title: 'Point retrograde',
    highlight: '[data-mode="retrograde"]',
    text: 'Select RETROGRADE—the direction opposite your motion. Burning backward removes orbital energy. At periapsis that lowers the far side of the path most strongly.',
    done: (ctx) => ctx.game?.active?.runtime.sas === 'retrograde',
  },
  {
    title: 'Begin lunar capture',
    highlight: '.hud-throttle-range',
    text: 'Set roughly 20% throttle. Watch the open flyby become a closed ellipse, then keep lowering Ap toward Pe. This is circularization: matching the high and low sides of an orbit.',
    done: (ctx) => (ctx.game?.active?.runtime.controls.throttle ?? 0) >= 0.15,
  },
  {
    title: 'Circularize low around the Moon',
    highlight: '.hud-apsis-indicator.ap',
    text: 'Hold retrograde and adjust throttle gently. Cut thrust once Ap is below 400 km, Pe remains above 30 km, and the two altitudes are within 120 km of each other.',
    done: (ctx) => isStableLowLunarOrbit(ctx),
  },
  {
    title: 'Lunar-orbit cutoff',
    highlight: '.hud-throttle-range',
    text: 'Press X. Your low lunar orbit is closed and stable; more retrograde thrust would lower it toward the terrain.',
    done: (ctx) => (ctx.game?.active?.runtime.controls.throttle ?? 1) <= 0.01,
  },
  {
    title: 'Inspect the lunar orbit',
    highlight: '[data-action="map"]',
    text: 'Open MAP if needed. Compare Ap and Pe: the closer they are, the more circular the orbit. You used the same mechanics at two worlds—burn direction changes the opposite side of an orbit.',
    done: (ctx) => ctx.mapVisible,
  },
];

export interface TutorialCallbacks {
  onComplete(phase: TutorialPhase): void;
  onRevert(): void;
  onContinueToMoon(): boolean;
  onStartSecondLight(): boolean;
}

interface DragState {
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

export class Tutorial {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly progressEl: HTMLElement;
  private readonly previousBtn: HTMLButtonElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;
  private readonly continueBtn: HTMLButtonElement;
  private readonly secondLightBtn: HTMLButtonElement;
  private phase: TutorialPhase = 'earth';
  private stepIndex = 0;
  private reviewIndex: number | null = null;
  private dismissed = false;
  private completed = false;
  private drag: DragState | null = null;
  active = false;

  constructor(uiRoot: HTMLElement, private readonly callbacks?: TutorialCallbacks) {
    this.root = document.createElement('aside');
    this.root.className = 'tut-box';
    this.root.setAttribute('aria-live', 'polite');
    injectUiStyles();

    this.headerEl = document.createElement('div');
    this.headerEl.className = 'tut-header';
    this.headerEl.tabIndex = 0;
    this.headerEl.title = 'Drag to move tutorial';
    this.progressEl = document.createElement('div');
    this.progressEl.className = 'tut-progress';
    const moveHint = document.createElement('span');
    moveHint.className = 'tut-move-hint';
    moveHint.textContent = 'MOVE';
    this.headerEl.append(this.progressEl, moveHint);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tut-title';
    this.textEl = document.createElement('div');
    this.textEl.className = 'tut-text';
    const actions = document.createElement('div');
    actions.className = 'tut-actions';
    this.previousBtn = document.createElement('button');
    this.previousBtn.className = 'hud-btn';
    this.previousBtn.textContent = 'Previous step';
    this.previousBtn.onclick = () => this.showPrevious();
    this.resumeBtn = document.createElement('button');
    this.resumeBtn.className = 'hud-btn';
    this.resumeBtn.textContent = 'Current step';
    this.resumeBtn.onclick = () => this.resumeCurrent();
    this.revertBtn = document.createElement('button');
    this.revertBtn.className = 'hud-btn';
    this.revertBtn.textContent = 'Revert to launch';
    this.revertBtn.title = 'Restore the prepared First Light vehicle to the launch pad';
    this.revertBtn.disabled = true;
    this.revertBtn.onclick = () => this.callbacks?.onRevert();
    this.continueBtn = document.createElement('button');
    this.continueBtn.className = 'hud-btn tut-continue';
    this.continueBtn.textContent = 'Continue to the Moon';
    this.continueBtn.hidden = true;
    this.continueBtn.onclick = () => this.continueToMoon();
    this.secondLightBtn = document.createElement('button');
    this.secondLightBtn.className = 'hud-btn tut-second-light';
    this.secondLightBtn.textContent = 'Start Second Light';
    this.secondLightBtn.title = 'Skip launch and begin the Moon lesson from a prepared Earth orbit';
    this.secondLightBtn.onclick = () => this.startSecondLight();
    const skip = document.createElement('button');
    skip.className = 'hud-btn';
    skip.textContent = 'Dismiss tutorial';
    skip.onclick = () => this.dismiss();
    actions.append(
      this.previousBtn,
      this.resumeBtn,
      this.continueBtn,
      this.secondLightBtn,
      this.revertBtn,
      skip,
    );
    this.root.append(this.headerEl, this.titleEl, this.textEl, actions);
    uiRoot.appendChild(this.root);
    this.root.style.display = 'none';

    this.headerEl.addEventListener('pointerdown', (event) => this.beginDrag(event));
    this.headerEl.addEventListener('pointermove', (event) => this.moveDrag(event));
    this.headerEl.addEventListener('pointerup', (event) => this.endDrag(event));
    this.headerEl.addEventListener('pointercancel', (event) => this.endDrag(event));
    this.headerEl.addEventListener('keydown', (event) => this.moveWithKeyboard(event));
  }

  start(): void {
    this.phase = 'earth';
    this.active = true;
    this.dismissed = false;
    this.completed = false;
    this.stepIndex = 0;
    this.reviewIndex = null;
    this.secondLightBtn.hidden = false;
    this.root.style.display = '';
    this.render();
  }

  dismiss(): void {
    this.dismissed = true;
    this.active = false;
    this.root.style.display = 'none';
    spotlight(null);
  }

  get currentStep(): number {
    return this.stepIndex;
  }

  restartAfterRevert(): void {
    if (!this.dismissed) this.start();
  }

  update(ctx: TutorialContext): void {
    if (this.dismissed) return;
    this.revertBtn.disabled = ctx.screen !== 'flight' || !ctx.game?.active;
    const steps = this.steps;
    if (this.reviewIndex !== null) {
      const review = steps[this.reviewIndex];
      spotlight(review.highlight ? document.querySelector(review.highlight) : null);
      return;
    }
    if (!this.active) return;
    const step = steps[this.stepIndex];
    if (!step) return;
    spotlight(step.highlight ? document.querySelector(step.highlight) : null);
    if (!step.done(ctx)) return;

    this.stepIndex++;
    if (this.stepIndex >= steps.length) {
      this.complete();
      return;
    }
    this.render();
  }

  private complete(): void {
    const firstCompletion = !this.completed;
    this.active = false;
    this.completed = true;
    spotlight(null);
    if (this.phase === 'earth') {
      this.progressEl.textContent = 'FIRST LIGHT · EARTH ORBIT ACHIEVED';
      this.titleEl.textContent = 'You are falling around Earth';
      this.textEl.textContent = 'That is the heart of Perilune: design a capable vehicle, shape its trajectory, and burn at the right place and time. Continue to plan a real maneuver node and carry the same spacecraft to the Moon.';
      this.continueBtn.hidden = false;
      this.secondLightBtn.hidden = false;
    } else {
      this.progressEl.textContent = 'FIRST LIGHT · LUNAR ORBIT ACHIEVED';
      this.titleEl.textContent = 'Two worlds, one set of mechanics';
      this.textEl.textContent = 'You raised an orbit with a forward burn, crossed spheres of influence, captured with a backward burn, and circularized by bringing apoapsis and periapsis together. First Light is complete.';
      this.continueBtn.hidden = true;
      this.secondLightBtn.hidden = true;
    }
    this.previousBtn.disabled = false;
    this.resumeBtn.hidden = true;
    if (firstCompletion) this.callbacks?.onComplete(this.phase);
  }

  private showPrevious(): void {
    const base = this.reviewIndex ?? Math.min(this.stepIndex, this.steps.length);
    if (base <= 0) return;
    this.reviewIndex = base - 1;
    this.render();
  }

  private resumeCurrent(): void {
    this.reviewIndex = null;
    if (this.completed) this.complete();
    else this.render();
  }

  private render(): void {
    const index = this.reviewIndex ?? this.stepIndex;
    const steps = this.steps;
    const step = steps[index];
    if (!step) return;
    this.progressEl.textContent = this.reviewIndex === null
      ? `FIRST LIGHT · ${this.phase === 'earth' ? 'EARTH' : 'MOON'} ${index + 1} / ${steps.length}`
      : `FIRST LIGHT · REVIEW ${index + 1} / ${steps.length}`;
    this.titleEl.textContent = step.title;
    this.textEl.textContent = step.text;
    this.previousBtn.disabled = index === 0;
    this.resumeBtn.hidden = this.reviewIndex === null;
    this.resumeBtn.textContent = this.completed ? 'Back to result' : 'Current step';
    this.continueBtn.hidden = true;
    this.secondLightBtn.hidden = this.phase !== 'earth';
  }

  private get steps(): readonly TutorialStep[] {
    return this.phase === 'earth' ? EARTH_STEPS : MOON_STEPS;
  }

  private continueToMoon(): void {
    if (!this.callbacks?.onContinueToMoon()) {
      this.textEl.textContent = 'A verified Moon intercept could not be created from this orbit. Revert to launch and complete Earth insertion again before continuing.';
      return;
    }
    this.beginMoonLesson();
  }

  private startSecondLight(): void {
    if (!this.callbacks?.onStartSecondLight()) {
      this.textEl.textContent = 'Second Light could not prepare a verified Moon transfer. Revert to launch and try again.';
      return;
    }
    this.beginMoonLesson();
  }

  private beginMoonLesson(): void {
    this.phase = 'moon';
    this.active = true;
    this.completed = false;
    this.stepIndex = 0;
    this.reviewIndex = null;
    this.continueBtn.hidden = true;
    this.secondLightBtn.hidden = true;
    this.render();
  }

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const rect = this.root.getBoundingClientRect();
    this.root.style.position = 'fixed';
    this.root.style.width = `${rect.width}px`;
    this.root.style.right = 'auto';
    this.root.style.left = `${rect.left}px`;
    this.root.style.top = `${rect.top}px`;
    this.drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
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
    if (this.headerEl.hasPointerCapture(event.pointerId)) this.headerEl.releasePointerCapture(event.pointerId);
    this.drag = null;
    this.root.classList.remove('dragging');
  }

  private moveWithKeyboard(event: KeyboardEvent): void {
    const delta = event.shiftKey ? 40 : 10;
    const movement: Record<string, [number, number]> = {
      ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta],
    };
    const move = movement[event.key];
    if (!move) return;
    const rect = this.root.getBoundingClientRect();
    this.root.style.position = 'fixed';
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
