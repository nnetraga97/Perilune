# Perilune Game Landing Page and Utility Launcher Design

**Date:** 2026-07-13
**Status:** Approved visual direction; awaiting written-spec review

## Goal

Replace the nearly blank main menu with a cinematic, recognizable game landing page and consolidate the Science, Saves, Settings, and Keys launcher controls into compact icon buttons that no longer form a second text row beneath the primary UI.

The result should feel like the front door to a spaceflight game rather than a web form: atmospheric artwork, a strong title, clear play choices, and secondary utilities that remain available without competing with the mission actions.

## Current-State Findings

- `PeriluneGame.buildMenu` constructs the entire menu with inline HTML and styles. The result is a centered title and six equal-width buttons over an almost empty radial gradient.
- `WindowManager` renders every registered utility as a text button in a centered launcher below the main editor toolbar. The Account, Science, Saves, Settings, and Keys controls create a visually disconnected second row.
- The editor already has a strong central command bar. Utility actions should join that row as a separate compact group rather than creating another navigation band.
- Existing utility windows, account behavior, save behavior, and key-reference behavior are functional and remain unchanged. This work changes discovery and presentation, not their underlying workflows.

## Approved Visual Direction

The approved direction is **C: cinematic orbital launch with a bottom command deck**.

The page uses a full-bleed generated image showing Veyra's curved atmospheric limb and a small near-future launch vehicle climbing through dawn. The image is composed with its brightest planetary and vehicle detail on the right, leaving darker atmospheric space on the left for the Perilune masthead. A controlled vignette and glass command deck guarantee readable UI contrast without hiding the artwork.

Visual character:

- Deep ink navy and atmospheric blue dominate.
- Warm amber from sunrise and engine plume is the sole high-energy accent.
- The interface stays industrial and restrained: fine borders, precise spacing, compact uppercase labels, and no decorative status dots.
- Motion is limited to a short entrance sequence for masthead and command deck plus restrained hover/focus transitions. The background itself remains still.

## Generated Background Asset

Generate one landscape raster asset for the menu, then store the selected result in the project rather than referencing an external or generated-images path.

Target prompt:

> Use case: stylized-concept. Asset type: full-bleed main-menu background for a near-future orbital spaceflight game. Scene: the curved blue atmospheric limb of the fictional terrestrial planet Veyra at dawn, seen from the upper atmosphere, with a small plausible launch vehicle climbing toward orbit and a restrained warm engine plume. Style: cinematic realistic concept art with grounded aerospace design, crisp atmospheric scattering, subtle cloud detail, and premium game key-art polish. Composition: 16:9 landscape; rocket and sunrise detail on the right third; dark uncluttered negative space across the left and lower-left for title and UI; horizon sweeping diagonally through the right half. Palette: deep ink navy, steel blue, pale cyan, and controlled amber sunrise. Constraints: no text, no logos, no UI, no watermark, no astronauts, no giant spacecraft, no fantasy nebulae, no lens-flare clutter.

The image should be delivered as a web-appropriate asset under `public/ui/`. CSS supplies the dark fallback gradient so the menu remains usable while the image loads or if it fails.

## Landing Page Structure

Move menu presentation out of `game.ts` into a bounded `MainMenu` UI component. `PeriluneGame` continues to own game-state transitions and passes callbacks into the component.

The component has three visual regions:

1. **Masthead, upper-left**
   - Cooperative eyebrow
   - PERILUNE wordmark rendered as text
   - Short line: “Build with care. Fly beyond Veyra. Bring them home.”

2. **Command deck, along the bottom**
   - Continue Mission
   - First Light
   - Sandbox
   - Secondary utility icon group

3. **Minimal metadata, upper-right**
   - Small build/program label only
   - No live-status dot or decorative connectivity indicator

### Action hierarchy

- When the autosave exists, **Continue Mission** is the amber primary action and includes concise last-save context when available.
- When no autosave exists, Continue is omitted rather than displayed as a dead button. **First Light** becomes primary.
- First Light remains the guided tutorial entry.
- Sandbox remains the direct build-and-fly entry.
- Saves, Account, and Settings appear as icon buttons at the command deck's trailing edge.

### Responsive behavior

- Wide screens use one horizontal command deck: Continue, First Light, Sandbox, then utilities.
- Medium screens allow narrower mission cards while retaining one row.
- Narrow screens change the deck to a two-column mission grid with the utility row spanning both columns.
- The masthead and deck retain safe-area padding. The background uses `cover` with a position biased toward the generated image's right-side subject.

## Shared Icon System

Add a small code-native icon helper for the limited utility set. Use inline SVG with `currentColor`; do not add an icon package or generate bitmap icons.

Required icons:

- Science archive
- Saves
- Account
- Settings
- Keyboard controls
- Orbit instruments
- Surface instruments
- Vessel instruments
- Alarms
- Transfer planner
- Fleet
- Mission log

Every icon button must include:

- A stable accessible name (`aria-label`)
- A visible text tooltip on mouse hover and keyboard focus
- A native `title` fallback
- A clear focus ring
- Existing active/open state styling where applicable

Tooltips are informational labels, not new status indicators.

## In-Game Utility Launcher

Extend the window registration contract so each launcher action provides an icon and accessible label. Existing `buttonLabel` values remain window titles or fallbacks but are no longer rendered as the default launcher face.

The launcher becomes one compact icon group in the same visual row as the screen's primary command bar:

- Editor: grouped with the top workshop command bar, eliminating the second centered row.
- Flight: grouped into the top HUD command region without covering system controls.
- Menu: the shared launcher stays hidden; Saves, Account, and Settings are rendered by `MainMenu`.

Science, Saves, Settings, and Keys use icon-only faces with hover/focus text. Account and the flight-only instrument/mission launchers use the same treatment so the launcher never mixes icon and text faces. Windows and callbacks remain owned by their current modules.

## Component Boundaries

- `src/ui/mainMenu.ts`: menu DOM, save-availability presentation, responsive semantic structure, and callbacks.
- `src/ui/icons.ts`: inline SVG construction for the approved utility icons.
- `src/ui/window.ts`: icon-aware launcher registration and mounting in a supplied screen toolbar host.
- `src/ui/kit.ts`: shared menu, icon-button, tooltip, command-deck, responsive, and entrance styles.
- `src/game.ts`: constructs `MainMenu`, supplies callbacks, and mounts the utility launcher to the active screen's toolbar host.
- `public/ui/`: final generated background asset.

The implementation should expose explicit toolbar-host elements from `Editor` and `FlightHud` rather than querying arbitrary DOM classes from `game.ts`.

## Interaction and Accessibility

- All existing actions preserve their behavior and keyboard bindings.
- Tooltips appear on both `:hover` and `:focus-visible`.
- Icon buttons remain at least 36 px square on desktop and 42 px on narrow/touch layouts.
- Motion respects `prefers-reduced-motion`.
- Text contrast is protected by the vignette and command-deck surface rather than by baking text into the generated image.
- The generated image is decorative and does not require alternative text; the page's actual title and actions remain semantic DOM content.

## Verification

- Add focused coverage for adaptive Continue/First Light hierarchy and icon accessible names where the existing test environment supports DOM behavior.
- Update the browser journey selectors only where the visible label moved into an accessible name; keep action names stable so role-based selectors continue to work.
- Verify desktop and narrow layouts in a real browser.
- Verify every launcher icon exposes its tooltip by hover and keyboard focus.
- Run the full unit suite and production build after implementation.
- Preserve the existing uncommitted decoupler/staging fix and avoid bundling it into the design-spec commit.

## Non-Goals

- No changes to save, account, settings, science, or keybinding behavior.
- No animated starfield, video background, or continuously moving parallax layer.
- No new game modes, campaign progression, marketing links, patch notes, or social links.
- No decorative status dots.
