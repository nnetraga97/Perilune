# Game Landing Page and Utility Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved cinematic Perilune command-deck landing page and replace the detached text launcher with accessible icon controls integrated into the editor and flight HUD.

**Architecture:** A new `MainMenu` component owns landing-page DOM and adaptive action hierarchy while `PeriluneGame` retains game transitions. A small code-native SVG icon module supplies all launcher/menu icons; `WindowManager` mounts the same launcher into explicit toolbar hosts exposed by `Editor` and `FlightHud`. The generated background is a local project asset with a CSS fallback.

**Tech Stack:** Strict TypeScript, plain DOM, inline SVG, shared CSS in `src/ui/kit.ts`, Vitest for pure UI contracts, Playwright with system Chrome for browser behavior, built-in image generation for the raster background.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-13-game-landing-page-design.md` as the source of truth.
- Use the approved cinematic orbital-launch direction and bottom command deck.
- Do not add an icon dependency; icons are local inline SVG using `currentColor`.
- Do not bake text, logos, or UI into the generated background.
- Do not add decorative status dots.
- Tooltips must appear on mouse hover and keyboard focus; every icon button must have an `aria-label` and `title`.
- Respect `prefers-reduced-motion` and keep the background still.
- Preserve all existing save, account, settings, science, keybinding, instrument-window, and mission-tool behavior.
- Preserve the current uncommitted staging fix in `src/sim/state.ts`, `src/sim/vessel.ts`, `tests/stage-partition.test.ts`, and `tests/vessel.test.ts`; never stage those files in this plan's commits.
- Do not push without explicit user approval.

## File Structure

- Create `public/ui/perilune-command-deck-bg.jpg` — selected generated landing-page art.
- Create `src/ui/icons.ts` — icon names, path registry, SVG builder, and accessible icon-button helper.
- Create `src/ui/mainMenu.ts` — menu state model, semantic DOM, command-deck rendering, and callbacks.
- Create `tests/ui-icons.test.ts` — icon-registry completeness and safety checks.
- Create `tests/main-menu.test.ts` — adaptive mission-action model coverage.
- Create `e2e/main-menu.spec.ts` — landing-page, tooltip, launcher-host, and responsive behavior.
- Modify `src/ui/window.ts` — icon-aware registrations and launcher host mounting.
- Modify `src/ui/editor.ts` — expose the editor toolbar utility host.
- Modify `src/ui/flightHud.ts` — expose the flight utility rail host.
- Modify `src/ui/flightInstruments.ts` — register icons for Orbit, Surface, and Vessel.
- Modify `src/ui/missionTools.ts` — register icons for Alarms, Transfers, and Fleet.
- Modify `src/ui/utilityTools.ts` — register icons for Science, Saves, Log, and Settings.
- Modify `src/ui/account.ts` — register the Account icon.
- Modify `src/ui/kit.ts` — command deck, launcher, tooltip, responsive, and reduced-motion styles.
- Modify `src/game.ts` — construct `MainMenu`, route callbacks, mount launcher hosts, and remove inline `buildMenu`.
- Modify sandbox-entry selectors in `e2e/game-loop.spec.ts`, `e2e/editor-interactions.spec.ts`, `e2e/mission-tools.spec.ts`, `e2e/veyra-pad-stationary.spec.ts`, `e2e/veyra-render-diagnostics.spec.ts`, and `e2e/part-models.spec.ts`.

---

### Task 1: Generate and Install the Cinematic Background

**Files:**
- Create: `public/ui/perilune-command-deck-bg.jpg`

**Interfaces:**
- Consumes: approved image composition from the design spec.
- Produces: `/ui/perilune-command-deck-bg.jpg`, referenced by Task 3 menu styles.

- [ ] **Step 1: Generate the source image with the built-in image tool**

Use the built-in image-generation path with no reference image and this exact prompt:

```text
Use case: stylized-concept
Asset type: full-bleed main-menu background for a near-future orbital spaceflight game
Primary request: Create premium cinematic key art for Perilune showing the curved blue atmospheric limb of the fictional terrestrial planet Veyra at dawn, with a small plausible launch vehicle climbing toward orbit and a restrained warm engine plume.
Scene/backdrop: upper atmosphere and orbital horizon, grounded aerospace realism, subtle cloud detail, crisp atmospheric scattering
Style/medium: realistic cinematic game concept art, refined rather than fantastical
Composition/framing: 16:9 landscape; rocket and sunrise on the right third; dark uncluttered negative space across the left and lower-left for title and menu; horizon sweeps diagonally through the right half
Lighting/mood: quiet determination, cold blue atmosphere against controlled amber sunrise
Color palette: deep ink navy, steel blue, pale cyan, controlled amber
Constraints: no text, no logos, no UI, no watermark, no astronauts, no giant spacecraft, no fantasy nebulae, no lens-flare clutter
```

Expected: one landscape image with the subject on the right and clean dark space on the left.

- [ ] **Step 2: Inspect the generated image before installing it**

Use the image viewer at original detail and reject the result if any of these are present:

- embedded text or watermark;
- rocket centered under the future title area;
- bright cloud or flare behind the left-side masthead;
- fantasy spacecraft proportions;
- insufficient dark space along the bottom command-deck region.

If one condition fails, regenerate once with only the failed constraint strengthened.

- [ ] **Step 3: Copy and compress the selected project asset**

Create `public/ui/`, copy the selected generated image there as a temporary PNG, then convert it:

```bash
mkdir -p public/ui
sips -s format jpeg -s formatOptions 88 \
  public/ui/perilune-command-deck-bg-source.png \
  --out public/ui/perilune-command-deck-bg.jpg
rm public/ui/perilune-command-deck-bg-source.png
```

Expected: a JPEG in the project; no runtime reference points into `$CODEX_HOME/generated_images`.

- [ ] **Step 4: Validate the asset**

Run:

```bash
file public/ui/perilune-command-deck-bg.jpg
sips -g pixelWidth -g pixelHeight public/ui/perilune-command-deck-bg.jpg
test -s public/ui/perilune-command-deck-bg.jpg
```

Expected: valid JPEG, landscape dimensions, non-zero file.

- [ ] **Step 5: Commit only the image asset**

```bash
git add public/ui/perilune-command-deck-bg.jpg
git diff --cached --check
git commit -m "assets: add Perilune menu key art"
```

---

### Task 2: Add the Icon System and Replace the Text Launcher

**Files:**
- Create: `src/ui/icons.ts`
- Create: `tests/ui-icons.test.ts`
- Modify: `src/ui/window.ts`
- Modify: `src/ui/editor.ts`
- Modify: `src/ui/flightHud.ts`
- Modify: `src/ui/flightInstruments.ts`
- Modify: `src/ui/missionTools.ts`
- Modify: `src/ui/utilityTools.ts`
- Modify: `src/ui/account.ts`
- Modify: `src/ui/kit.ts`
- Modify: `src/game.ts`

**Interfaces:**
- Consumes: existing `el`, `WindowDef`, `WindowManager`, editor top bar, and flight HUD root.
- Produces:

```ts
export const UTILITY_ICON_NAMES: readonly UtilityIcon[];
export type UtilityIcon =
  | 'science' | 'save' | 'account' | 'settings' | 'keyboard' | 'orbit'
  | 'surface' | 'vessel' | 'alarm' | 'transfer' | 'fleet' | 'log';
export function appendUiIcon(parent: HTMLElement, icon: UtilityIcon): SVGSVGElement;
export function iconButton(
  parent: HTMLElement,
  icon: UtilityIcon,
  label: string,
  onClick: () => void,
  className?: string,
): HTMLButtonElement;
export interface WindowDef { launcherIcon: UtilityIcon; /* existing fields unchanged */ }
WindowManager.setLauncherHost(host: HTMLElement | null): void;
WindowManager.addAction(icon: UtilityIcon, label: string, fn: () => void): void;
Editor.utilityHost: HTMLElement;
FlightHud.utilityHost: HTMLElement;
```

- [ ] **Step 1: Write the icon-registry test**

Create `tests/ui-icons.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, UTILITY_ICON_NAMES } from '../src/ui/icons';

describe('utility icon registry', () => {
  it('covers every approved launcher without text glyphs', () => {
    expect(UTILITY_ICON_NAMES).toEqual([
      'science', 'save', 'account', 'settings', 'keyboard', 'orbit',
      'surface', 'vessel', 'alarm', 'transfer', 'fleet', 'log',
    ]);
    for (const name of UTILITY_ICON_NAMES) {
      expect(ICON_PATHS[name].length).toBeGreaterThan(0);
      expect(ICON_PATHS[name].join(' ')).not.toMatch(/<text|status|dot/i);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify red**

Run:

```bash
npx vitest run tests/ui-icons.test.ts
```

Expected: FAIL because `src/ui/icons.ts` does not exist.

- [ ] **Step 3: Implement the icon registry and accessible button helper**

Create `src/ui/icons.ts` with a static path registry. Use outline paths in a `24 24` view box and no `<text>` elements:

```ts
import { el } from './kit';

export const UTILITY_ICON_NAMES = [
  'science', 'save', 'account', 'settings', 'keyboard', 'orbit',
  'surface', 'vessel', 'alarm', 'transfer', 'fleet', 'log',
] as const;
export type UtilityIcon = (typeof UTILITY_ICON_NAMES)[number];

export const ICON_PATHS: Readonly<Record<UtilityIcon, readonly string[]>> = {
  science: ['M9 3h6', 'M10 3v5l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3', 'M8 14h8'],
  save: ['M5 3h12l2 2v16H5z', 'M8 3v6h8V3', 'M8 15h8v6'],
  account: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M4 21a8 8 0 0 1 16 0'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1'],
  keyboard: ['M3 6h18v12H3z', 'M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10'],
  orbit: ['M12 12m-8 0a8 3 0 1 0 16 0 8 3 0 1 0-16 0', 'M12 12m0-8a3 8 0 1 0 0 16 3 8 0 1 0 0-16', 'M12 10v4'],
  surface: ['M3 17l5-7 4 4 3-4 6 7', 'M3 20h18', 'M5 6h4'],
  vessel: ['M12 2l4 7v8l-4 5-4-5V9z', 'M8 14l-3 3M16 14l3 3', 'M10 9h4'],
  alarm: ['M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3z', 'M10 20h4', 'M5 4 3 2M19 4l-3 2'],
  transfer: ['M4 7h13', 'M14 4l3 3-3 3', 'M20 17H7', 'M10 14l-3 3 3 3'],
  fleet: ['M7 3l3 5-3 5-3-5z', 'M17 8l3 5-3 5-3-5z', 'M9 18h5'],
  log: ['M5 3h14v18H5z', 'M8 7h8M8 11h8M8 15h5'],
};

export function appendUiIcon(parent: HTMLElement, icon: UtilityIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('k-icon-svg');
  for (const d of ICON_PATHS[icon]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  parent.appendChild(svg);
  return svg;
}

export function iconButton(
  parent: HTMLElement,
  icon: UtilityIcon,
  label: string,
  onClick: () => void,
  className = '',
): HTMLButtonElement {
  const button = el('button', `k-icon-btn ${className}`.trim(), parent) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  appendUiIcon(button, icon);
  const tooltip = el('span', 'k-icon-tooltip', button, label);
  tooltip.setAttribute('aria-hidden', 'true');
  button.onclick = onClick;
  return button;
}
```

- [ ] **Step 4: Run the icon test to verify green**

Run:

```bash
npx vitest run tests/ui-icons.test.ts
```

Expected: 1 file passed.

- [ ] **Step 5: Make window registrations icon-aware**

In `src/ui/window.ts`:

- import `iconButton` and `UtilityIcon`;
- require `launcherIcon` on `WindowDef`;
- replace text-button creation in `register` with:

```ts
const btn = iconButton(
  this.launcher,
  def.launcherIcon,
  def.buttonLabel ?? def.title,
  () => win.setOpen(!win.open),
  'k-launcher-btn',
);
```

- replace `addAction` with:

```ts
addAction(icon: UtilityIcon, label: string, fn: () => void): void {
  iconButton(this.launcher, icon, label, fn, 'k-launcher-btn');
}
```

- add explicit host mounting:

```ts
setLauncherHost(host: HTMLElement | null): void {
  (host ?? this.uiRoot).appendChild(this.launcher);
  this.launcher.classList.toggle('k-launcher-floating', host === null);
}
```

Keep `setScreen('menu')` responsible for hiding the launcher.

- [ ] **Step 6: Expose toolbar hosts**

In `Editor`, add `readonly utilityHost: HTMLElement` and construct it at the end of the existing top bar:

```ts
this.utilityHost = el('div', 'ed-utility-host', top);
```

In `FlightHud`, add `readonly utilityHost: HTMLElement` and construct a dedicated top-left host:

```ts
this.utilityHost = el('div', 'hud-utility-host', this.root);
```

- [ ] **Step 7: Assign all launcher icons**

Add `launcherIcon` to every registration using this exact mapping:

```text
account -> account
science-archive -> science
save-browser -> save
notification-log -> log
settings -> settings
flight-orbital -> orbit
flight-surface -> surface
flight-vessel -> vessel
alarms -> alarm
transfers -> transfer
fleet -> fleet
```

Update the Keys registration in `game.ts`:

```ts
this.windows.addAction('keyboard', 'Keyboard reference (?)', () => {
  if (this.screen === 'flight' || this.screen === 'editor') {
    this.cheatSheet.toggle(this.screen as BindingScreen);
  }
});
```

- [ ] **Step 8: Mount the launcher for each screen**

Update the three screen transitions in `game.ts`:

```ts
// showMenu
this.windows.setLauncherHost(null);
this.windows.setScreen('menu');

// toEditor
this.windows.setLauncherHost(this.editor.utilityHost);
this.windows.setScreen('editor');

// toFlight
this.windows.setLauncherHost(this.hud.utilityHost);
this.windows.setScreen('flight');
```

- [ ] **Step 9: Replace launcher CSS**

In `src/ui/kit.ts`, remove the centered absolute launcher rules and add:

```css
.k-launcher { display:flex; flex-wrap:wrap; gap:4px; pointer-events:auto; }
.ed-utility-host { display:flex; align-items:center; margin-left:2px; padding-left:7px; border-left:1px solid #2a3d4d; }
.hud-utility-host { position:absolute; top:10px; left:12px; width:208px; z-index:44; pointer-events:auto; }
.hud-utility-host .k-launcher { max-width:208px; }
.k-icon-btn { position:relative; width:30px; height:30px; padding:0; display:grid; place-items:center;
  border:1px solid #2f4859; border-radius:5px; background:rgba(9,19,27,.9); color:#a9c2ce; cursor:pointer; }
.k-icon-btn:hover,.k-icon-btn:focus-visible { border-color:var(--ui-accent); color:#fff; outline:none; }
.k-icon-btn.active { border-color:var(--ui-accent); background:#16303f; color:#fff; }
.k-icon-svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.7;
  stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
.k-icon-tooltip { position:absolute; left:50%; bottom:calc(100% + 7px); transform:translate(-50%,4px);
  opacity:0; visibility:hidden; white-space:nowrap; pointer-events:none; padding:5px 7px;
  border:1px solid #49677a; border-radius:4px; background:#08131b; color:#eaf3f7; font-size:10px;
  transition:opacity .12s ease,transform .12s ease; z-index:70; }
.k-icon-btn:hover .k-icon-tooltip,.k-icon-btn:focus-visible .k-icon-tooltip {
  opacity:1; visibility:visible; transform:translate(-50%,0); }
.hud-events { top:88px; }
```

- [ ] **Step 10: Run focused verification**

Run:

```bash
npx vitest run tests/ui-icons.test.ts tests/ui-windows.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript exits 0.

- [ ] **Step 11: Commit only launcher files**

```bash
git add src/ui/icons.ts src/ui/window.ts src/ui/editor.ts src/ui/flightHud.ts \
  src/ui/flightInstruments.ts src/ui/missionTools.ts src/ui/utilityTools.ts \
  src/ui/account.ts src/ui/kit.ts src/game.ts tests/ui-icons.test.ts
git diff --cached --check
git commit -m "feat: compact utility launchers into icon controls"
```

---

### Task 3: Build and Integrate the Command-Deck Main Menu

**Files:**
- Create: `src/ui/mainMenu.ts`
- Create: `tests/main-menu.test.ts`
- Modify: `src/ui/kit.ts`
- Modify: `src/game.ts`

**Interfaces:**
- Consumes: `SaveGame`, `iconButton`, `/ui/perilune-command-deck-bg.jpg`, and existing game callbacks.
- Produces:

```ts
export type MissionEntry = 'continue' | 'first-light' | 'sandbox';
export interface MenuMission {
  id: MissionEntry;
  eyebrow: string;
  title: string;
  detail: string;
  primary: boolean;
}
export function menuMissions(save: SaveGame | null): readonly MenuMission[];
export interface MainMenuCallbacks {
  onContinue(): Promise<void> | void;
  onFirstLight(): void;
  onSandbox(): void;
  onSaves(): void;
  onAccount(): void;
  onSettings(): void;
}
export class MainMenu {
  readonly root: HTMLElement;
  constructor(parent: HTMLElement, callbacks: MainMenuCallbacks);
  setContinueSave(save: SaveGame | null): void;
  setVisible(visible: boolean): void;
}
```

- [ ] **Step 1: Write the adaptive hierarchy test**

Create `tests/main-menu.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SaveGame } from '../src/save/schema';
import { menuMissions } from '../src/ui/mainMenu';

const save = {
  label: 'autosave',
  time: 412,
  activeVesselId: 'v1',
  vessels: [{ name: 'Wayfarer' }],
} as unknown as SaveGame;

describe('main-menu mission hierarchy', () => {
  it('leads with Continue when an autosave exists', () => {
    const missions = menuMissions(save);
    expect(missions.map((mission) => mission.id)).toEqual(['continue', 'first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('continue');
    expect(missions[0].detail).toContain('Wayfarer');
  });

  it('omits dead Continue and promotes First Light without a save', () => {
    const missions = menuMissions(null);
    expect(missions.map((mission) => mission.id)).toEqual(['first-light', 'sandbox']);
    expect(missions.find((mission) => mission.primary)?.id).toBe('first-light');
  });
});
```

- [ ] **Step 2: Run the test to verify red**

Run:

```bash
npx vitest run tests/main-menu.test.ts
```

Expected: FAIL because `src/ui/mainMenu.ts` does not exist.

- [ ] **Step 3: Implement the pure mission model**

In `src/ui/mainMenu.ts`, implement `menuMissions` so it returns:

```ts
const base: MenuMission[] = [
  { id: 'first-light', eyebrow: 'GUIDED', title: 'FIRST LIGHT', detail: 'Learn the program', primary: !save },
  { id: 'sandbox', eyebrow: 'OPEN PROGRAM', title: 'SANDBOX', detail: 'Build and fly freely', primary: false },
];
if (!save) return base;
const activeName = save.vessels.find((vessel) => vessel.id === save.activeVesselId)?.name
  ?? save.vessels[0]?.name
  ?? save.label;
return [
  { id: 'continue', eyebrow: 'LAST FLIGHT', title: 'CONTINUE MISSION',
    detail: `${activeName} · UT ${Math.max(0, Math.floor(save.time))}s`, primary: true },
  ...base,
];
```

Use the actual saved vessel field (`name` is on `SavedVessel`) and exact `id`/`activeVesselId` lookup.

- [ ] **Step 4: Run the model test to verify green**

Run:

```bash
npx vitest run tests/main-menu.test.ts
```

Expected: 2 tests passed.

- [ ] **Step 5: Implement the `MainMenu` DOM component**

Build semantic DOM with these stable classes:

```text
perilune-menu
perilune-menu-vignette
perilune-menu-masthead
perilune-menu-eyebrow
perilune-menu-logo
perilune-menu-tagline
perilune-menu-build
perilune-command-deck
perilune-mission
perilune-mission-primary
perilune-mission-eyebrow
perilune-mission-title
perilune-mission-detail
perilune-menu-utilities
```

Use actual buttons for missions. Set `aria-label` to the stable action names:

```ts
const actionLabels: Record<MissionEntry, string> = {
  continue: 'Continue Mission',
  'first-light': 'First Light tutorial',
  sandbox: 'Sandbox — just build and fly',
};
```

Use `iconButton` for `Save & Load`, `Account`, and `Settings`. `setContinueSave` stores the save and rebuilds only the command deck; `setVisible` changes `root.style.display` between `''` and `'none'`.

- [ ] **Step 6: Add the approved menu styling**

Append a `/* main menu */` section to `src/ui/kit.ts` with:

```css
.perilune-menu { position:absolute; inset:0; overflow:hidden; z-index:40; pointer-events:auto;
  background:#03080d url('/ui/perilune-command-deck-bg.jpg') 72% center/cover no-repeat; }
.perilune-menu-vignette { position:absolute; inset:0; background:
  linear-gradient(90deg,rgba(2,7,12,.86) 0%,rgba(2,7,12,.30) 52%,rgba(2,7,12,.15)),
  linear-gradient(0deg,rgba(2,7,12,.72),transparent 42%); }
.perilune-menu-masthead { position:absolute; left:clamp(28px,6vw,96px); top:clamp(54px,11vh,116px); }
.perilune-menu-eyebrow { color:#9fb5c2; font-size:10px; letter-spacing:3px; }
.perilune-menu-logo { margin-top:9px; color:#a1dcf2; font-size:clamp(44px,6vw,82px); line-height:.92;
  font-weight:300; letter-spacing:clamp(10px,1.6vw,22px); text-shadow:0 5px 24px rgba(50,151,195,.28); }
.perilune-menu-tagline { margin-top:14px; max-width:420px; color:#c0ccd2; font-size:12px; letter-spacing:.7px; }
.perilune-menu-build { position:absolute; top:28px; right:34px; color:#8da3af; font:9px var(--ui-mono); letter-spacing:1.5px; }
.perilune-command-deck { position:absolute; left:3.5vw; right:3.5vw; bottom:4vh; display:grid;
  grid-template-columns:minmax(250px,1.5fr) minmax(190px,1fr) minmax(190px,1fr) auto; gap:8px;
  padding:10px; background:linear-gradient(180deg,rgba(9,18,26,.86),rgba(5,11,17,.95));
  border:1px solid rgba(100,163,193,.5); border-top-color:#73bfdf; backdrop-filter:blur(12px);
  box-shadow:0 18px 50px rgba(0,0,0,.42); animation:menuDeckIn .45s ease-out both; }
.perilune-mission { min-height:76px; padding:12px 14px; text-align:left; color:#e8f0f3;
  border:1px solid #345267; background:rgba(10,23,33,.68); cursor:pointer; }
.perilune-mission:hover,.perilune-mission:focus-visible { border-color:#8ed1ec; outline:none; transform:translateY(-1px); }
.perilune-mission-primary { border-color:#dca94a; background:linear-gradient(120deg,rgba(121,75,24,.56),rgba(28,36,39,.76)); }
.perilune-mission-eyebrow { display:block; color:#8fa7b4; font-size:8px; letter-spacing:2px; }
.perilune-mission-title { display:block; margin-top:5px; font-size:14px; letter-spacing:.8px; }
.perilune-mission-detail { display:block; margin-top:5px; color:#9fadb4; font-size:9px; }
.perilune-menu-utilities { display:flex; align-items:center; gap:6px; padding:0 4px 0 10px; border-left:1px solid #29404f; }
.perilune-menu-utilities .k-icon-btn { width:42px; height:42px; }
@keyframes menuDeckIn { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
@media (max-width:820px) {
  .perilune-menu { background-position:68% center; }
  .perilune-command-deck { grid-template-columns:1fr 1fr; bottom:20px; }
  .perilune-menu-utilities { grid-column:1/-1; border-left:0; border-top:1px solid #29404f; padding:8px 0 0; }
}
@media (prefers-reduced-motion:reduce) {
  .perilune-command-deck { animation:none; }
  .perilune-mission,.k-icon-tooltip { transition:none; }
}
```

- [ ] **Step 7: Replace inline menu ownership in `game.ts`**

Replace `private menuEl` with:

```ts
private menu!: MainMenu;
```

After `UtilityTools` and `AccountWindow` are available, construct:

```ts
this.menu = new MainMenu(this.uiRoot, {
  onFirstLight: () => {
    this.newGame();
    this.tutorial.start();
    this.toEditor();
  },
  onSandbox: () => {
    this.newGame();
    this.toEditor();
  },
  onContinue: () => this.continueAutosave(),
  onSaves: () => this.utilityTools.openSaves(),
  onAccount: () => this.account.open(),
  onSettings: () => this.utilityTools.openSettings(),
});
void this.refreshMenuSave();
```

Extract the old Continue body into:

```ts
private async continueAutosave(): Promise<void> {
  const save = await this.saveSync.read('auto');
  if (!save) {
    this.menu.setContinueSave(null);
    return;
  }
  this.game = restoreGame(save);
  if (this.game.active) this.toFlight(false);
  else this.toEditor();
}

private async refreshMenuSave(): Promise<void> {
  this.menu.setContinueSave(await this.saveSync.read('auto'));
}
```

Delete `buildMenu`. Update screen transitions to use `this.menu.setVisible(...)`, and call `void this.refreshMenuSave()` in `showMenu`.

- [ ] **Step 8: Run focused tests and typechecking**

Run:

```bash
npx vitest run tests/main-menu.test.ts tests/ui-icons.test.ts tests/ui-windows.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 9: Commit the menu slice**

```bash
git add src/ui/mainMenu.ts src/ui/kit.ts src/game.ts tests/main-menu.test.ts
git diff --cached --check
git commit -m "feat: redesign the Perilune landing page"
```

---

### Task 4: Browser Contracts, Responsive Review, and Final Verification

**Files:**
- Create: `e2e/main-menu.spec.ts`
- Modify: `e2e/game-loop.spec.ts`
- Modify: `e2e/editor-interactions.spec.ts`
- Modify: `e2e/mission-tools.spec.ts`
- Modify: `e2e/veyra-pad-stationary.spec.ts`
- Modify: `e2e/veyra-render-diagnostics.spec.ts`
- Modify: `e2e/part-models.spec.ts`

**Interfaces:**
- Consumes: accessible menu/launcher labels and stable CSS classes from Tasks 2–3.
- Produces: browser regression coverage and final desktop/narrow screenshots.

- [ ] **Step 1: Update the existing Sandbox entry selectors**

Replace every:

```ts
await page.getByText('Sandbox — just build and fly').click();
```

with:

```ts
await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
```

This preserves the stable accessible name while allowing the visible command-deck copy to be richer.

- [ ] **Step 2: Write the menu and launcher browser test**

Create `e2e/main-menu.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('landing page and utility launchers use the approved hierarchy', async ({ page }) => {
  await page.goto('/');
  const menu = page.locator('.perilune-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('background-image', /perilune-command-deck-bg\.jpg/);
  await expect(page.getByRole('button', { name: 'Continue Mission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'First Light tutorial' })).toHaveClass(/perilune-mission-primary/);
  await expect(page.getByRole('button', { name: 'Save & Load' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await expect(page.locator('.ed-utility-host .k-launcher')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Science' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saves' })).toBeVisible();
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.hover();
  await expect(settings.locator('.k-icon-tooltip')).toBeVisible();
  await settings.focus();
  await expect(settings.locator('.k-icon-tooltip')).toBeVisible();
});

test('command deck becomes a two-column layout on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto('/');
  const deck = page.locator('.perilune-command-deck');
  await expect(deck).toBeVisible();
  await expect(deck).toHaveCSS('grid-template-columns', /[0-9.]+px [0-9.]+px/);
  await page.screenshot({ path: 'test-results/perilune-menu-narrow.png', fullPage: true });
});
```

- [ ] **Step 3: Run the menu journey and one core editor journey**

Run:

```bash
npx playwright test e2e/main-menu.spec.ts e2e/editor-interactions.spec.ts
```

Expected: both files pass with no browser console errors.

- [ ] **Step 4: Capture and inspect the desktop menu**

Run the preview server and take a 1440×900 screenshot using Playwright's configured system Chrome. Inspect at original size for:

- unobstructed rocket and planetary limb;
- readable masthead and mission cards;
- no dead Continue button in a clean browser profile;
- utility icons aligned at the command deck's trailing edge;
- no second text launcher beneath the editor toolbar;
- no clipped tooltip at viewport edges.

If layout changes are needed, edit only `mainMenu.ts`/`kit.ts`, rerun `e2e/main-menu.spec.ts`, and recapture once.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run build
npx playwright test e2e/main-menu.spec.ts e2e/game-loop.spec.ts \
  e2e/editor-interactions.spec.ts e2e/mission-tools.spec.ts e2e/part-models.spec.ts
git diff --check
```

Expected:

- all Vitest files pass;
- production build exits 0;
- the menu and core gameplay browser journeys pass;
- `git diff --check` emits no output.

- [ ] **Step 6: Commit browser contracts and final polish**

```bash
git add e2e/main-menu.spec.ts e2e/game-loop.spec.ts e2e/editor-interactions.spec.ts \
  e2e/mission-tools.spec.ts e2e/veyra-pad-stationary.spec.ts \
  e2e/veyra-render-diagnostics.spec.ts e2e/part-models.spec.ts \
  src/ui/mainMenu.ts src/ui/kit.ts
git diff --cached --check
git commit -m "test: cover the game landing experience"
```

Do not stage or commit the pre-existing staging-fix files.
