/**
 * Shared UI kit: the DOM helper and the single consolidated stylesheet for
 * every screen (HUD, map, editor, tutorial). Plain DOM with direct mutation
 * per the UI-layer ADR — this module adds shared structure, not a framework.
 *
 * Class names are unchanged from the per-file era so existing e2e journeys
 * and tests keep working; new components should build on the `k-` prefix.
 */

/** Create an element with a class, append it, optionally set text. */
export function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

const STYLE_ID = 'ui-kit-style';

/**
 * Inject the consolidated stylesheet once. Every UI module calls this from
 * its constructor; repeat calls are no-ops.
 */
export function injectUiStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
      /* ============================== kit primitives */
      .k-overlay { position: absolute; inset: 0; display: flex; align-items: center;
        justify-content: center; background: rgba(4,8,12,0.55); z-index: 60; pointer-events: auto; }
      .k-sheet { background: rgba(10,16,22,0.97); border: 1px solid #2a3d4d; border-radius: 10px;
        padding: 14px 18px; max-width: 720px; max-height: 78vh; overflow-y: auto; }
      .k-sheet h2 { font-size: 13px; letter-spacing: 3px; color: var(--ui-accent); margin: 0 0 10px; font-weight: normal; }
      .k-sheet-groups { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
      .k-sheet-group { min-width: 200px; }
      .k-sheet-group h3 { font-size: 10px; letter-spacing: 2px; color: #9fb4c4; margin: 0 0 5px; font-weight: normal; }
      .k-key-row { display: flex; gap: 10px; font-size: 12px; padding: 1.5px 0; }
      .k-key { font-family: var(--ui-mono); color: var(--ui-accent); min-width: 86px; }
      .k-key-label { color: #c4d2dd; }
      .k-sheet-hint { margin-top: 10px; font-size: 10.5px; color: #7d8b96; }

      /* ============================== flight HUD */
      .hud { position: absolute; inset: 0; pointer-events: none; font-family: var(--ui-font); }
      .hud button { pointer-events: auto; }
      .hud-btn {
        background: var(--ui-bg); color: var(--ui-fg); border: 1px solid #2a3d4d;
        border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer;
      }
      .hud-btn:hover { border-color: var(--ui-accent); color: #fff; }
      .hud-top { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 14px; align-items: center; background: var(--ui-bg);
        border: 1px solid #223240; border-radius: 8px; padding: 6px 16px; pointer-events: auto; }
      .hud-met { font-family: var(--ui-mono); font-size: 14px; color: var(--ui-accent); min-width: 90px; }
      .hud-situation { font-size: 12px; letter-spacing: 2px; color: #9fb4c4; min-width: 90px; text-align: center; }
      .hud-warp { font-family: var(--ui-mono); font-size: 13px; color: var(--ui-warn); min-width: 60px; text-align: right; }
      .hud-warp-btns { display: flex; gap: 4px; }
      .hud-sys { position: absolute; top: 10px; right: 12px; display: flex; gap: 6px; }
      .hud-recover { border-color: var(--ui-good); }
      .hud-left { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px;
        display: flex; align-items: flex-end; gap: 10px; pointer-events: auto; }
      .hud-navwrap { position: relative; }
      .hud-navball { display: block; }
      .hud-sas { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; align-content: end; }
      .hud-sas-btn { width: 34px; height: 30px; padding: 2px; font-size: 14px; }
      .hud-sas-btn.active { border-color: var(--ui-accent); background: #16303f; color: #fff; }
      .hud-throttle { display: flex; flex-direction: column; align-items: center; gap: 4px; }
      .hud-throttle-label { font-size: 10px; color: #9fb4c4; }
      .hud-throttle-track { width: 14px; height: 150px; background: #101c26; border: 1px solid #2a3d4d;
        border-radius: 4px; position: relative; overflow: hidden; }
      .hud-throttle-fill { position: absolute; bottom: 0; left: 0; right: 0; background: var(--ui-warn); height: 0%; }
      .hud-readouts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .hud-readout { background: var(--ui-bg); border: 1px solid #223240; border-radius: 6px; padding: 4px 10px; min-width: 110px; }
      .hud-readout-label { font-size: 9px; letter-spacing: 1.5px; color: #7d8b96; }
      .hud-readout-value { font-family: var(--ui-mono); font-size: 15px; }
      .hud-right { position: absolute; right: 12px; top: 56px; display: flex; flex-direction: column; gap: 8px;
        width: 230px; pointer-events: auto; }
      .hud-panel { background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .hud-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; padding: 1px 0; }
      .hud-key { color: #7d8b96; font-size: 11px; min-width: 34px; }
      .hud-val { font-family: var(--ui-mono); }
      .hud-eta { margin-left: auto; color: #7d8b96; font-size: 11px; font-family: var(--ui-mono); }
      .hud-node-info { font-family: var(--ui-mono); font-size: 12px; color: var(--ui-accent); margin-top: 4px; white-space: pre-line; }
      .hud-gauge { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
      .hud-gauge-track { flex: 1; height: 8px; background: #101c26; border-radius: 4px; overflow: hidden; }
      .hud-gauge-fill { height: 100%; width: 0%; background: var(--ui-accent); }
      .hud-gauge-text { font-family: var(--ui-mono); font-size: 10px; color: #9fb4c4; min-width: 50px; text-align: right; }
      .hud-systems { display: flex; flex-direction: column; gap: 4px; }
      .hud-sys-toggle { width: 100%; text-align: left; font-size: 11px; }
      .hud-sys-toggle.active { border-color: var(--ui-good); color: #cfe8d6; }
      .hud-stages { max-height: 40vh; overflow-y: auto; }
      .hud-stage-btn { width: 100%; margin-bottom: 6px; border-color: var(--ui-warn); }
      .hud-stage-list { display: flex; flex-direction: column-reverse; gap: 4px; }
      .hud-stage { border: 1px solid #223240; border-radius: 5px; padding: 3px 8px; font-size: 11px; }
      .hud-stage.next { border-color: var(--ui-warn); }
      .hud-stage.spent { opacity: 0.35; }
      .hud-stage-title { color: #9fb4c4; font-size: 10px; letter-spacing: 1px; }
      .hud-events { position: absolute; left: 12px; top: 56px; display: flex; flex-direction: column; gap: 4px; max-width: 320px; }
      .hud-event { background: var(--ui-bg); border-left: 3px solid var(--ui-accent); border-radius: 4px;
        padding: 5px 10px; font-size: 12px; animation: hudfade 6s forwards; }
      .hud-event.warning { border-left-color: var(--ui-warn); }
      .hud-event.danger { border-left-color: var(--ui-danger); }
      @keyframes hudfade { 0% { opacity: 0; } 5% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }

      /* ============================== map view */
      .map-panel { position: absolute; left: 12px; bottom: 12px; width: 300px;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px;
        padding: 10px 12px; pointer-events: auto; }
      .map-title { font-size: 11px; letter-spacing: 2px; color: #9fb4c4; margin-bottom: 8px; }
      .map-row { display: flex; gap: 6px; margin-bottom: 8px; }
      .map-node-panel { display: flex; flex-direction: column; gap: 6px; }
      .map-axis { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .map-axis label { width: 66px; color: #9fb4c4; font-size: 11px; }
      .map-axis input[type=range] { flex: 1; }
      .map-axis .val { font-family: var(--ui-mono); width: 64px; text-align: right; }
      .map-axis button { width: 24px; padding: 2px; }
      .map-readout { font-family: var(--ui-mono); font-size: 12px; color: var(--ui-accent); padding: 2px 0; }
      .map-encounter { font-family: var(--ui-mono); font-size: 12px; color: #c88be8; white-space: pre-line; padding-top: 4px; }

      /* ============================== workshop editor */
      .ed-root { position: absolute; inset: 0; pointer-events: none; }
      .ed-root button, .ed-root input, .ed-root select { pointer-events: auto; }
      .ed-left { position: absolute; left: 0; top: 0; bottom: 0; width: 244px;
        background: rgba(10,16,22,0.94); border-right: 1px solid #223240;
        display: flex; flex-direction: column; pointer-events: auto; }
      .ed-title { padding: 10px 12px 4px; font-size: 15px; letter-spacing: 3px; color: var(--ui-accent); }
      .ed-cats { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 8px; }
      .ed-cat { font-size: 10px; padding: 3px 7px; }
      .ed-cat.active { border-color: var(--ui-accent); background: #16303f; }
      .ed-parts { flex: 1; overflow-y: auto; padding: 4px 8px; display: flex; flex-direction: column; gap: 4px; }
      .ed-part { border: 1px solid #223240; border-radius: 6px; padding: 6px 8px; cursor: pointer;
        background: rgba(20,30,40,0.6); }
      .ed-part:hover { border-color: var(--ui-accent); }
      .ed-part-name { font-size: 12px; color: #d8e2ea; }
      .ed-part-info { font-size: 10px; color: #7d8b96; }
      .ed-right { position: absolute; right: 0; top: 0; bottom: 0; width: 268px;
        background: rgba(10,16,22,0.94); border-left: 1px solid #223240;
        display: flex; flex-direction: column; gap: 8px; padding: 10px; overflow-y: auto; pointer-events: auto; }
      .ed-panel { border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .ed-panel h3 { font-size: 10px; letter-spacing: 2px; color: #9fb4c4; margin-bottom: 6px; font-weight: normal; }
      .ed-stats { font-family: var(--ui-mono); font-size: 11.5px; line-height: 1.55; white-space: pre; }
      .ed-warn { color: var(--ui-warn); font-size: 11px; padding: 2px 0; }
      .ed-stage { border: 1px solid #223240; border-radius: 5px; padding: 4px 6px; margin-bottom: 4px; font-size: 11px; }
      .ed-stage-head { display: flex; gap: 4px; align-items: center; color: #9fb4c4; font-size: 10px; }
      .ed-stage-head button { padding: 0 6px; font-size: 10px; }
      .ed-topbar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 8px; align-items: center; pointer-events: auto;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 6px 12px; }
      .ed-name { background: #101c26; border: 1px solid #2a3d4d; color: var(--ui-fg);
        border-radius: 5px; padding: 4px 8px; width: 190px; font-size: 13px; }
      .ed-launch { border-color: var(--ui-good) !important; color: var(--ui-good) !important; font-weight: bold; }
      .ed-hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
        background: var(--ui-bg); border-radius: 6px; padding: 4px 14px; font-size: 11px; color: #9fb4c4; }
      .ed-craft-list { display: flex; flex-direction: column; gap: 3px; }
      .ed-craft-item { display: flex; gap: 4px; }
      .ed-craft-item button { font-size: 11px; }

      /* ============================== tutorial */
      .tut-box { position: absolute; left: 260px; top: 56px; width: 320px;
        background: rgba(14,24,32,0.95); border: 1px solid var(--ui-accent);
        border-radius: 10px; padding: 12px 14px; pointer-events: auto; z-index: 40; }
      .tut-progress { font-size: 10px; letter-spacing: 2px; color: var(--ui-accent); }
      .tut-title { font-size: 15px; margin: 4px 0 6px; color: #fff; }
      .tut-text { font-size: 12.5px; line-height: 1.5; color: #c4d2dd; }
      .tut-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  `;
  document.head.appendChild(style);
}
