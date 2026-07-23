import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtemisIvGuideViewModel } from '../src/missions/artemisIv/guide';
import { ARTEMIS_IV_STAND_IN_LABEL } from '../src/missions/artemisIv/mission';
import {
  ArtemisIvGuide,
  type ArtemisIvGuideCallbacks,
  type ArtemisIvGuideContextualAction,
} from '../src/ui/artemisIvGuide';

class TestClassList {
  constructor(private readonly owner: TestElement) {}

  toggle(token: string, force?: boolean): boolean {
    const tokens = new Set(this.owner.className.split(/\s+/).filter(Boolean));
    const add = force ?? !tokens.has(token);
    if (add) tokens.add(token);
    else tokens.delete(token);
    this.owner.className = [...tokens].join(' ');
    return add;
  }

  contains(token: string): boolean {
    return this.owner.className.split(/\s+/).includes(token);
  }
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly classList = new TestClassList(this);
  className = '';
  id = '';
  textContent = '';
  hidden = false;
  disabled = false;
  tabIndex = -1;
  title = '';
  onclick: (() => void) | null = null;

  constructor(readonly tagName: string) {}

  append(...children: TestElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: TestElement): TestElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: TestElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
  }

  addEventListener(): void {}

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  click(): void {
    if (!this.disabled) this.onclick?.();
  }

  byClass(className: string): TestElement[] {
    const matches: TestElement[] = this.classList.contains(className) ? [this] : [];
    return [...matches, ...this.children.flatMap((child) => child.byClass(className))];
  }

  byTag(tagName: string): TestElement[] {
    const matches: TestElement[] = this.tagName === tagName ? [this] : [];
    return [...matches, ...this.children.flatMap((child) => child.byTag(tagName))];
  }
}

class TestDocument {
  readonly head = new TestElement('head');
  readonly body = new TestElement('body');

  createElement(tagName: string): TestElement {
    return new TestElement(tagName);
  }

  getElementById(id: string): TestElement | null {
    return [...this.head.byTag('style'), ...this.body.byTag('style')].find((element) => element.id === id) ?? null;
  }
}

function viewModel(overrides: Partial<ArtemisIvGuideViewModel> = {}): ArtemisIvGuideViewModel {
  return {
    missionLabel: 'ARTEMIS IV',
    accuracyLabel: ARTEMIS_IV_STAND_IN_LABEL,
    chapter: 2,
    chapterTitle: 'Rendezvous and proximity operations',
    kind: 'read',
    title: 'Review the mission configuration',
    doNext: 'Read the provider note, then continue.',
    successMessage: null,
    stepNumber: 1,
    stepCount: 3,
    confirmationRemainingMs: 0,
    primaryAction: { id: 'continue', label: 'CONTINUE' },
    ...overrides,
  };
}

function mount(): {
  host: TestElement;
  root: TestElement;
  callbacks: ArtemisIvGuideCallbacks;
  guide: ArtemisIvGuide;
} {
  const document = new TestDocument();
  vi.stubGlobal('document', document);
  const host = new TestElement('div');
  const callbacks: ArtemisIvGuideCallbacks = {
    onContinue: vi.fn(),
    onContextualAction: vi.fn(),
    onRetryChapter: vi.fn(),
    onSkipChapter: vi.fn(),
    onExit: vi.fn(),
  };
  const guide = new ArtemisIvGuide(host as unknown as HTMLElement, callbacks);
  return { host, root: host.children[0], callbacks, guide };
}

afterEach(() => vi.unstubAllGlobals());

describe('Artemis IV guide DOM', () => {
  it('renders mission truth, accessible progress, and one primary Continue action', () => {
    const { root, callbacks, guide } = mount();
    guide.setVisible(true);
    guide.update(viewModel());

    expect(root.hidden).toBe(false);
    expect(root.getAttribute('aria-label')).toBe('Artemis IV mission guide');
    expect(root.byClass('tut-box')).toHaveLength(0);
    expect(root.byClass('tut-title')).toHaveLength(0);
    expect(root.byClass('tut-step-kind')).toHaveLength(0);
    expect(root.byClass('artiv-guide-mission')[0].textContent).toBe('ARTEMIS IV');
    expect(root.byClass('artiv-guide-accuracy')[0].textContent).toBe(ARTEMIS_IV_STAND_IN_LABEL);
    expect(root.byClass('artiv-guide-chapter-title')[0].textContent).toBe('Rendezvous and proximity operations');
    expect(root.byClass('artiv-guide-next-label')[0].textContent).toBe('DO NEXT');
    const header = root.byClass('artiv-guide-header')[0];
    expect(header.tabIndex).toBe(0);
    expect(header.title).toMatch(/drag to move/i);
    expect(header.getAttribute('aria-label')).toMatch(/arrow keys/i);
    expect(root.byClass('artiv-guide-mode')[0].textContent).toBe('MOVE');

    const rail = root.byClass('artiv-guide-rail')[0];
    expect(rail.getAttribute('role')).toBe('progressbar');
    expect(rail.getAttribute('aria-valuenow')).toBe('1');
    expect(rail.getAttribute('aria-valuemax')).toBe('3');
    expect(rail.children).toHaveLength(3);
    expect(rail.byClass('is-current')).toHaveLength(1);

    const primary = root.byClass('artiv-guide-primary');
    expect(primary).toHaveLength(1);
    expect(primary[0].hidden).toBe(false);
    expect(primary[0].textContent).toBe('CONTINUE');
    primary[0].click();
    expect(callbacks.onContinue).toHaveBeenCalledOnce();
    expect(callbacks.onContextualAction).not.toHaveBeenCalled();
    const secondary = root.byClass('artiv-guide-secondary-action');
    expect(secondary).toHaveLength(3);
    expect(secondary[1].textContent).toBe('Skip chapter');
    expect(secondary[1].getAttribute('aria-label')).toBe('Skip Artemis IV chapter 2');
    secondary[1].click();
    expect(callbacks.onSkipChapter).toHaveBeenCalledOnce();
  });

  it('lets a contextual action replace Continue and presents compact live readouts', () => {
    const { root, callbacks, guide } = mount();
    const action: ArtemisIvGuideContextualAction = {
      id: 'open-maneuver',
      label: 'OPEN MANEUVER PLANNER',
      ariaLabel: 'Open the maneuver planner for lunar insertion',
    };
    guide.update(viewModel({ kind: 'do' }), {
      contextualAction: action,
      readouts: [
        { label: 'Range', value: '184 m', tone: 'good' },
        { label: 'Closing rate', value: '0.42 m/s', tone: 'caution' },
      ],
    });

    const primary = root.byClass('artiv-guide-primary')[0];
    expect(primary.textContent).toBe('OPEN MANEUVER PLANNER');
    expect(primary.getAttribute('aria-label')).toBe('Open the maneuver planner for lunar insertion');
    primary.click();
    expect(callbacks.onContextualAction).toHaveBeenCalledWith(action);
    expect(callbacks.onContinue).not.toHaveBeenCalled();

    const readouts = root.byClass('artiv-guide-readouts')[0];
    expect(readouts.hidden).toBe(false);
    expect(readouts.children).toHaveLength(2);
    expect(readouts.byTag('dt').map((element) => element.textContent)).toEqual(['Range', 'Closing rate']);
    expect(readouts.byTag('dd').map((element) => element.textContent)).toEqual(['184 m', '0.42 m/s']);
    expect(readouts.children[1].dataset.tone).toBe('caution');
  });

  it('shows the confirmation dwell without a competing primary action and keeps recovery actions quiet', () => {
    const { root, callbacks, guide } = mount();
    guide.update(viewModel({
      kind: 'watch',
      successMessage: 'SAFE HOLD ESTABLISHED',
      confirmationRemainingMs: 400,
      stepNumber: 2,
      primaryAction: null,
    }), {
      contextualAction: { id: 'target-lander', label: 'TARGET LANDER' },
    });

    expect(root.classList.contains('artiv-guide-step-complete')).toBe(true);
    expect(root.dataset.confirmationRemainingMs).toBe('400');
    expect(root.byClass('artiv-guide-confirmation')[0].hidden).toBe(false);
    expect(root.byClass('artiv-guide-confirmation-label')[0].textContent).toBe('STEP COMPLETE');
    expect(root.byClass('artiv-guide-confirmation-message')[0].textContent).toBe('SAFE HOLD ESTABLISHED');
    expect(root.byClass('artiv-guide-primary')[0].hidden).toBe(true);
    expect(root.byClass('is-current')).toHaveLength(0);
    expect(root.byClass('is-complete')).toHaveLength(2);

    const [retry, skip, exit] = root.byClass('artiv-guide-secondary-action');
    retry.click();
    skip.click();
    exit.click();
    expect(callbacks.onRetryChapter).toHaveBeenCalledOnce();
    expect(callbacks.onSkipChapter).toHaveBeenCalledOnce();
    expect(callbacks.onExit).toHaveBeenCalledOnce();

    guide.setVisible(false);
    expect(root.hidden).toBe(true);
  });

  it('renames the final chapter skip action without hiding it', () => {
    const { root, guide } = mount();
    guide.update(viewModel({ chapter: 10 }));

    const skip = root.byClass('artiv-guide-skip')[0];
    expect(skip.hidden).toBe(false);
    expect(skip.textContent).toBe('Finish from checkpoint');
    expect(skip.getAttribute('aria-label')).toBe('Finish Artemis IV from the chapter checkpoint');
  });
});
