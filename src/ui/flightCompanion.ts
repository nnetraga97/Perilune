import type { Situation } from '../sim/flight';
import { el } from './kit';

export type FlightCompanionTone = 'info' | 'warning' | 'success' | 'danger';

export interface FlightCompanionAdvisory {
  id: string;
  headline: string;
  message: string;
  tone: FlightCompanionTone;
  source?: 'local' | 'ai';
  action?: string;
}

export interface FlightCompanionSnapshot {
  vesselId: string;
  situation: Situation;
  fuelFraction: number | null;
  chargeFraction: number | null;
  dynamicPressurePa: number;
  dynamicPressureLimitPa: number;
  properG: number;
  commsBlocked: boolean;
  nodeBurnStartEta: number | null;
  predictedImpactSpeed: number | null;
}

const PHASE_CALLOUTS: Readonly<Partial<Record<Situation, FlightCompanionAdvisory>>> = {
  prelaunch: {
    id: 'phase-prelaunch',
    headline: 'Ready when you are',
    message: "I'm Pip. I'll keep an eye on the flight and call out what matters.",
    tone: 'info',
  },
  flying: {
    id: 'phase-flying',
    headline: 'Positive flight',
    message: 'Watch the air-load and acceleration strips as the atmosphere thickens.',
    tone: 'info',
  },
  suborbital: {
    id: 'phase-suborbital',
    headline: 'Suborbital arc',
    message: 'Your path still returns to the surface. If orbit is the goal, raise periapsis before the coast runs out.',
    tone: 'info',
  },
  orbit: {
    id: 'phase-orbit',
    headline: 'Orbit confirmed',
    message: 'Nice flying. You have a closed path around the body and time to plan the next move.',
    tone: 'success',
  },
  escaping: {
    id: 'phase-escaping',
    headline: 'Escape trajectory',
    message: 'This path leaves the current body. Check the map before committing more fuel.',
    tone: 'warning',
  },
  landed: {
    id: 'phase-landed',
    headline: 'Surface contact',
    message: 'Touchdown confirmed. Secure the vehicle before starting surface operations.',
    tone: 'success',
  },
  splashed: {
    id: 'phase-splashed',
    headline: 'Splashdown',
    message: 'The vehicle is afloat and stable. Recovery is available when you are ready.',
    tone: 'success',
  },
  destroyed: {
    id: 'phase-destroyed',
    headline: 'Vehicle lost',
    message: 'The flight has ended. Review the last callouts before revising the vehicle.',
    tone: 'danger',
  },
};

/**
 * Select one grounded local callout from the telemetry already calculated by
 * the simulator. The future model response can bypass this selector and use
 * FlightCompanion.present() without changing the component or its layout.
 */
export function chooseFlightCompanionAdvisory(
  snapshot: FlightCompanionSnapshot,
): FlightCompanionAdvisory | null {
  if (snapshot.situation === 'destroyed') return PHASE_CALLOUTS.destroyed ?? null;

  if (snapshot.commsBlocked) {
    return {
      id: 'alert-comms',
      headline: 'Control link lost',
      message: 'This probe cannot receive commands. Re-establish a relay path before the next maneuver.',
      tone: 'danger',
    };
  }

  if (snapshot.dynamicPressurePa >= snapshot.dynamicPressureLimitPa * 0.85) {
    return {
      id: 'alert-high-q',
      headline: 'Heavy air-load',
      message: `Dynamic pressure is ${(snapshot.dynamicPressurePa / 1000).toFixed(1)} kPa. Ease the climb if the load keeps rising.`,
      tone: 'warning',
    };
  }

  if (snapshot.properG >= 4) {
    return {
      id: 'alert-high-g',
      headline: 'High acceleration',
      message: `The vehicle is pulling ${snapshot.properG.toFixed(1)} g. Ease thrust if crew or structure limits are close.`,
      tone: 'warning',
    };
  }

  if (snapshot.predictedImpactSpeed !== null && snapshot.predictedImpactSpeed >= 20) {
    return {
      id: 'alert-hard-arrival',
      headline: 'Hard arrival predicted',
      message: `Current entry prediction reaches the surface near ${snapshot.predictedImpactSpeed.toFixed(0)} m/s. Plan a braking burn.`,
      tone: 'danger',
    };
  }

  if (snapshot.nodeBurnStartEta !== null && snapshot.nodeBurnStartEta <= 15 && snapshot.nodeBurnStartEta >= -5) {
    return {
      id: 'alert-node-burn',
      headline: snapshot.nodeBurnStartEta <= 0 ? 'Begin the burn' : 'Burn coming up',
      message: snapshot.nodeBurnStartEta <= 0
        ? 'The centered maneuver-burn window is open. Follow the node marker.'
        : `Centered burn start is in ${Math.ceil(snapshot.nodeBurnStartEta)} seconds. Set attitude and throttle.`,
      tone: 'warning',
    };
  }

  if (snapshot.fuelFraction !== null && snapshot.fuelFraction <= 0.1) {
    return {
      id: 'alert-low-fuel',
      headline: 'Fuel reserve low',
      message: `${Math.max(0, snapshot.fuelFraction * 100).toFixed(0)}% propellant remains. Protect the margin for landing or correction burns.`,
      tone: 'warning',
    };
  }

  if (snapshot.chargeFraction !== null && snapshot.chargeFraction <= 0.1) {
    return {
      id: 'alert-low-charge',
      headline: 'Battery reserve low',
      message: `${Math.max(0, snapshot.chargeFraction * 100).toFixed(0)}% charge remains. Preserve power for control and communications.`,
      tone: 'warning',
    };
  }

  return PHASE_CALLOUTS[snapshot.situation] ?? null;
}

function appendPipMark(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'hud-companion-mark');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <path class="pip-shell" d="M18 12h28l8 10v25l-9 8H19l-9-8V22z"/>
    <path class="pip-glass" d="M17 23c4-5 9-7 15-7s11 2 15 7v17c-4 5-9 7-15 7s-11-2-15-7z"/>
    <path class="pip-brow" d="M22 27l6-2M42 27l-6-2"/>
    <circle class="pip-eye" cx="25" cy="32" r="2.4"/>
    <circle class="pip-eye" cx="39" cy="32" r="2.4"/>
    <path class="pip-smile" d="M26 39c2 2 4 3 6 3s4-1 6-3"/>
    <path class="pip-ear" d="M10 29H6v10h4M54 29h4v10h-4"/>
    <path class="pip-antenna" d="M32 12V7m-4 0h8"/>
  `;
  parent.appendChild(svg);
}

export class FlightCompanion {
  readonly root: HTMLElement;
  private readonly bubble: HTMLElement;
  private readonly avatar: HTMLButtonElement;
  private readonly sourceEl: HTMLElement;
  private readonly headlineEl: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly actionEl: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly briefBtn: HTMLButtonElement;
  private readonly seen = new Set<string>();
  private vesselId = '';
  private muted = false;
  private open = true;
  private lastAdvisory: FlightCompanionAdvisory | null = null;
  private hideTimer: number | null = null;

  constructor(
    parent: HTMLElement,
    onRequestBriefing?: () => Promise<FlightCompanionAdvisory>,
  ) {
    this.root = el('aside', 'hud-companion', parent);
    this.root.setAttribute('aria-label', 'Pip flight companion');

    this.avatar = el('button', 'hud-companion-avatar', this.root) as HTMLButtonElement;
    this.avatar.type = 'button';
    this.avatar.setAttribute('aria-label', 'Hide Pip flight companion message');
    this.avatar.setAttribute('aria-expanded', 'true');
    this.avatar.title = 'Show or hide Pip';
    appendPipMark(this.avatar);
    el('span', 'hud-companion-nameplate', this.avatar, 'PIP');

    this.bubble = el('div', 'hud-companion-bubble info', this.root);
    const header = el('div', 'hud-companion-header', this.bubble);
    el('span', 'hud-companion-title', header, 'FLIGHT COMPANION');
    this.sourceEl = el('span', 'hud-companion-source', header, 'LOCAL');
    this.muteBtn = el('button', 'hud-companion-mute', header, 'MUTE') as HTMLButtonElement;
    this.muteBtn.type = 'button';
    this.muteBtn.setAttribute('aria-label', 'Mute automatic companion callouts');
    this.muteBtn.setAttribute('aria-pressed', 'false');
    this.muteBtn.onclick = (event) => {
      event.stopPropagation();
      this.setMuted(!this.muted);
    };
    const close = el('button', 'hud-companion-close', header, '×') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', 'Hide companion message');
    close.onclick = () => this.setOpen(false);

    const copy = el('div', 'hud-companion-copy', this.bubble);
    copy.setAttribute('aria-live', 'polite');
    copy.setAttribute('aria-atomic', 'true');
    this.headlineEl = el('strong', 'hud-companion-headline', copy, 'Ready when you are');
    this.messageEl = el('p', 'hud-companion-message', copy, "I'm Pip. I'll keep an eye on the flight and call out what matters.");
    this.actionEl = el('div', 'hud-companion-action', copy);
    this.actionEl.style.display = 'none';
    const footer = el('div', 'hud-companion-footer', this.bubble);
    this.briefBtn = el('button', 'hud-companion-brief', footer, 'ASK PIP') as HTMLButtonElement;
    this.briefBtn.type = 'button';
    this.briefBtn.title = 'Generate an AI briefing from the current flight telemetry';
    this.briefBtn.disabled = !onRequestBriefing;
    this.briefBtn.onclick = async () => {
      if (!onRequestBriefing || this.briefBtn.disabled) return;
      this.briefBtn.disabled = true;
      this.briefBtn.textContent = 'READING TELEMETRY…';
      this.sourceEl.textContent = 'AI';
      this.headlineEl.textContent = 'Checking the flight';
      this.messageEl.textContent = 'Building a briefing from the current simulator snapshot.';
      this.actionEl.style.display = 'none';
      this.bubble.className = 'hud-companion-bubble info';
      this.setOpen(true);
      try {
        this.present(await onRequestBriefing());
      } catch {
        this.present({
          id: 'ai-unavailable',
          headline: 'Briefing unavailable',
          message: 'Pip could not reach flight control. Local guidance is still active.',
          tone: 'warning',
          source: 'local',
        });
      } finally {
        this.briefBtn.disabled = false;
        this.briefBtn.textContent = 'ASK PIP AGAIN';
      }
    };
    this.bubble.onmouseenter = () => this.clearHideTimer();
    this.bubble.onmouseleave = () => this.scheduleHide(4_500);
    this.bubble.addEventListener('focusin', () => this.clearHideTimer());
    this.bubble.addEventListener('focusout', () => this.scheduleHide(4_500));

    this.avatar.onclick = () => {
      if (this.muted) {
        this.setMuted(false);
        return;
      }
      this.setOpen(!this.open);
    };
  }

  update(snapshot: FlightCompanionSnapshot): void {
    if (snapshot.vesselId !== this.vesselId) {
      this.vesselId = snapshot.vesselId;
      this.seen.clear();
    }
    const advisory = chooseFlightCompanionAdvisory(snapshot);
    if (!advisory || this.seen.has(advisory.id)) return;
    this.seen.add(advisory.id);
    this.present(advisory);
  }

  /** Present either a local advisory or a structured AI response. */
  present(advisory: FlightCompanionAdvisory): void {
    this.lastAdvisory = advisory;
    this.headlineEl.textContent = advisory.headline;
    this.messageEl.textContent = advisory.message;
    this.actionEl.textContent = advisory.action ?? '';
    this.actionEl.style.display = advisory.action ? '' : 'none';
    this.sourceEl.textContent = advisory.source === 'ai' ? 'AI' : 'LOCAL';
    this.bubble.className = `hud-companion-bubble ${advisory.tone}`;
    if (!this.muted) {
      this.setOpen(true);
      this.scheduleHide(advisory.tone === 'danger' ? 12_000 : 9_000);
    }
  }

  private setOpen(open: boolean): void {
    this.clearHideTimer();
    this.open = open;
    this.root.classList.toggle('message-hidden', !open);
    this.bubble.hidden = !open;
    this.avatar.setAttribute('aria-expanded', String(open));
    this.avatar.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} Pip flight companion message`);
  }

  private setMuted(muted: boolean): void {
    this.muted = muted;
    this.root.classList.toggle('muted', muted);
    this.muteBtn.textContent = muted ? 'UNMUTE' : 'MUTE';
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    this.avatar.title = muted ? 'Pip is muted — click to restore callouts' : 'Show or hide Pip';
    if (muted) this.setOpen(false);
    else if (this.lastAdvisory) this.setOpen(true);
  }

  private scheduleHide(delayMs: number): void {
    this.clearHideTimer();
    if (!this.open || this.muted) return;
    this.hideTimer = window.setTimeout(() => this.setOpen(false), delayMs);
  }

  private clearHideTimer(): void {
    if (this.hideTimer === null) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
