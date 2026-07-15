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

let spotlightEl: HTMLElement | null = null;

/**
 * Highlight a UI element for the tutorial (or hide the highlight with null).
 * Cheap enough to call per frame; hides itself when the target is not
 * currently laid out (hidden screen, display:none ancestor).
 */
export function spotlight(target: Element | null): void {
  if (!spotlightEl) {
    if (!target) return;
    injectUiStyles();
    spotlightEl = document.createElement('div');
    spotlightEl.className = 'k-spotlight';
    document.body.appendChild(spotlightEl);
  }
  const visible = target instanceof HTMLElement && target.offsetParent !== null;
  if (!visible) {
    spotlightEl.style.display = 'none';
    return;
  }
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    spotlightEl.style.display = 'none';
    return;
  }
  spotlightEl.style.display = 'block';
  spotlightEl.style.left = `${rect.left - 4}px`;
  spotlightEl.style.top = `${rect.top - 4}px`;
  spotlightEl.style.width = `${rect.width + 8}px`;
  spotlightEl.style.height = `${rect.height + 8}px`;
}

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
      .k-ui-hidden > * { visibility: hidden !important; }
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
      .k-launcher { display:flex; flex-wrap:wrap; gap:4px; pointer-events:auto; }
      .ed-utility-host,.hud-utility-host { position:absolute; left:0; bottom:0; z-index:44; pointer-events:auto; }
      .ed-utility-host .k-launcher,.hud-utility-host .k-launcher {
        flex-direction:column; flex-wrap:nowrap; gap:2px; }
      .ed-utility-host .k-icon-btn,.hud-utility-host .k-icon-btn {
        border-left:0; border-radius:0 5px 5px 0; }
      .k-icon-btn { position:relative; width:36px; height:36px; padding:0; display:grid; place-items:center;
        border:1px solid #2f4859; border-radius:5px; background:rgba(9,19,27,.9); color:#a9c2ce; cursor:pointer; }
      .k-icon-btn:hover { border-color:var(--ui-accent); color:#fff; }
      .k-icon-btn:focus-visible { border-color:var(--ui-accent); color:#fff; outline:2px solid var(--ui-accent);
        outline-offset:2px; z-index:1; }
      .k-icon-btn.active { border-color:var(--ui-accent); background:#16303f; color:#fff; }
      .k-icon-svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.7;
        stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
      .k-icon-tooltip { position:absolute; left:50%; bottom:calc(100% + 7px); transform:translate(-50%,4px);
        opacity:0; visibility:hidden; white-space:nowrap; pointer-events:none; padding:5px 7px;
        border:1px solid #49677a; border-radius:4px; background:#08131b; color:#eaf3f7; font-size:10px;
        transition:opacity .12s ease,transform .12s ease; z-index:70; }
      .k-icon-btn:hover .k-icon-tooltip,.k-icon-btn:focus-visible .k-icon-tooltip {
        opacity:1; visibility:visible; transform:translate(-50%,0); }
      .ed-utility-host .k-icon-tooltip,
      .hud-utility-host .k-icon-tooltip { left:calc(100% + 7px); top:50%; bottom:auto;
        transform:translate(-4px,-50%); }
      .ed-utility-host .k-icon-btn:hover .k-icon-tooltip,
      .ed-utility-host .k-icon-btn:focus-visible .k-icon-tooltip,
      .hud-utility-host .k-icon-btn:hover .k-icon-tooltip,
      .hud-utility-host .k-icon-btn:focus-visible .k-icon-tooltip { transform:translate(0,-50%); }
      .k-window { position: absolute; min-width: 190px; max-width: 340px;
        background: rgba(10,16,22,0.94); border: 1px solid #2a3d4d; border-radius: 8px;
        z-index: 45; pointer-events: auto; }
      .k-window-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
        cursor: grab; border-bottom: 1px solid #1a2833; user-select: none; }
      .k-window-title { flex: 1; font-size: 10px; letter-spacing: 2px; color: #9fb4c4; }
      .k-window-btn { background: none; border: none; color: #7d8b96; cursor: pointer;
        font-size: 12px; padding: 0 3px; }
      .k-window-btn:hover { color: #fff; }
      .k-window-content { padding: 8px 10px; }
      .k-instrument-grid { display: grid; grid-template-columns: auto minmax(80px, 1fr); gap: 3px 14px; }
      .k-instrument-key { color: #7d8b96; font-size: 10.5px; }
      .k-instrument-value { color: #d8e2ea; font-family: var(--ui-mono); font-size: 11.5px; text-align: right; }
      .k-spotlight { position: fixed; border: 2px solid var(--ui-warn); border-radius: 8px;
        box-shadow: 0 0 12px rgba(226,177,60,0.55); pointer-events: none; z-index: 55;
        transition: left 0.15s ease-out, top 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out;
        display: none; }
      .k-render-failure { position:absolute; top:64px; left:50%; transform:translateX(-50%);
        z-index:58; display:flex; align-items:center; gap:12px; max-width:min(680px,calc(100vw - 32px));
        padding:9px 12px; border:1px solid var(--ui-warn); border-radius:7px;
        background:rgba(24,18,8,.96); color:#f1dfae; font-size:12px; box-shadow:0 8px 28px rgba(0,0,0,.35); }
      .k-render-failure[hidden] { display:none; }
      .k-render-failure-message { flex:1; }
      .k-render-failure-retry { border:1px solid #8f7335; border-radius:4px; padding:5px 9px;
        background:#2b210d; color:#fff0c5; cursor:pointer; white-space:nowrap; }
      .k-render-failure-retry:hover,.k-render-failure-retry:focus-visible { border-color:var(--ui-warn); }

      /* ============================== flight HUD */
      .hud { position: absolute; inset: 0; pointer-events: none; font-family: var(--ui-font); }
      .hud button { pointer-events: auto; }
      .hud-btn {
        background: var(--ui-bg); color: var(--ui-fg); border: 1px solid #2a3d4d;
        border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer;
      }
      .hud-btn:hover { border-color: var(--ui-accent); color: #fff; }
      .hud-btn:disabled { cursor: not-allowed; opacity: 0.42; border-color: #34434e; color: #788791; }
      .hud-btn:disabled:hover { border-color: #34434e; color: #788791; }
      .hud-top { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 14px; align-items: center; background: var(--ui-bg);
        border: 1px solid #223240; border-radius: 8px; padding: 6px 16px; pointer-events: auto; }
      .hud-met { font-family: var(--ui-mono); font-size: 14px; color: var(--ui-accent); min-width: 90px; }
      .hud-ut { font-family: var(--ui-mono); font-size: 10px; color: #7d8b96; min-width: 74px; }
      .hud-next-alarm { font-family: var(--ui-mono); font-size: 10px; color: var(--ui-warn); min-width: 94px; }
      .hud-situation { font-size: 12px; letter-spacing: 2px; color: #9fb4c4; min-width: 90px; text-align: center; }
      .hud-crew { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: #b7c8d4; font-size: 10px; letter-spacing: 1px; }
      .hud-warp { font-family: var(--ui-mono); font-size: 13px; color: var(--ui-warn); min-width: 60px; text-align: right; }
      .hud-warp-btns { display: flex; gap: 4px; }
      .hud-sys { position: absolute; top: 10px; right: 12px; display: flex; gap: 6px; }
      .hud-recover { border-color: var(--ui-good); }
      .hud-left { position:absolute; left:50%; bottom:42px; width:224px; height:224px;
        transform:translateX(-50%); pointer-events:auto; }
      .hud-navwrap { position:relative; width:224px; height:224px;
        filter:drop-shadow(0 12px 18px rgba(0,0,0,.42)); }
      .hud-navball { display: block; }
      .hud-nav-speed { position:absolute; z-index:3; left:50%; top:-14px; transform:translateX(-50%);
        width:154px; height:36px; display:grid; grid-template-columns:52px 1fr; align-items:center;
        background:linear-gradient(180deg,#0d1b24,#071017); border:1px solid #526d7d; border-radius:5px 5px 2px 2px;
        box-shadow:0 5px 16px rgba(0,0,0,.4); }
      .hud-nav-speed-mode { color:#7f99a8; font:8px var(--ui-mono); letter-spacing:1.3px; text-align:center;
        border-right:1px solid #2e4554; }
      .hud-nav-speed-value { color:#eef5f7; font:700 14px var(--ui-mono); text-align:center; }
      .hud-sas { position:absolute; z-index:3; left:-96px; top:34px; width:74px; padding:5px;
        display:grid; grid-template-columns:1fr 1fr; gap:4px; align-content:end;
        background:linear-gradient(180deg,rgba(9,19,27,.97),rgba(5,12,18,.97));
        border:1px solid #38566a; border-radius:6px 2px 2px 6px; box-shadow:0 8px 24px rgba(0,0,0,.36); }
      .hud-sas-heading { grid-column:1/-1; color:#7893a2; font:8px var(--ui-mono); letter-spacing:1.2px;
        text-align:center; padding-bottom:2px; }
      .hud-sas-btn { width:29px; height:27px; padding:2px; font-size:13px; display:grid; place-items:center; }
      .hud-sas-icon { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.75;
        stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
      .hud-sas-btn[data-mode="prograde"] { color:#c8e86b; }
      .hud-sas-btn[data-mode="retrograde"] { color:#e8a06b; }
      .hud-sas-btn.active { border-color: var(--ui-accent); background: #16303f; color: #fff; }
      .hud-nav-data { position:absolute; z-index:3; right:-82px; top:42px; width:76px; display:flex;
        flex-direction:column; gap:5px; }
      .hud-nav-datum { padding:5px 7px; background:rgba(7,16,23,.94); border:1px solid #38566a;
        border-radius:2px 6px 6px 2px; }
      .hud-nav-datum-label { display:block; color:#708b9a; font:7px var(--ui-mono); letter-spacing:1.2px; }
      .hud-nav-datum-value { display:block; margin-top:2px; color:#eef4f6; font:700 10px var(--ui-mono);
        white-space:nowrap; }
      .hud-nav-controls { position:absolute; z-index:4; left:50%; bottom:-31px; transform:translateX(-50%);
        min-width:206px; height:36px; padding:4px; display:grid; grid-template-columns:44px 44px minmax(98px,1fr);
        gap:4px; background:linear-gradient(180deg,#0d1b24,#071017); border:1px solid #526d7d;
        border-radius:2px 2px 6px 6px; box-shadow:0 7px 18px rgba(0,0,0,.4); }
      .hud-nav-toggle { border:1px solid #354f60; border-radius:3px; background:#0b1821; color:#7e96a4;
        font:700 10px var(--ui-mono); letter-spacing:1px; cursor:pointer; }
      .hud-nav-toggle:hover,.hud-nav-toggle:focus-visible { border-color:var(--ui-accent); color:#fff; }
      .hud-nav-toggle.active { border-color:#7fb8a4; background:#173329; color:#bfe9d8;
        box-shadow:inset 0 0 10px rgba(73,164,130,.18); }
      .hud-nav-guidance-mode { display:grid; place-items:center; padding:0 7px; border:1px solid #2f4655;
        color:#9db1bd; font:8px var(--ui-mono); letter-spacing:.8px; white-space:nowrap; }
      .hud-status-strip { position:absolute; z-index:3; left:312px; bottom:0; width:142px;
        display:flex; flex-direction:column; gap:5px; }
      .hud-status-row { display: grid; grid-template-columns: 28px 1fr 58px; gap: 5px; align-items: center; }
      .hud-status-key { font-size: 9px; color: #7d8b96; letter-spacing: 1px; }
      .hud-status-track { height: 6px; border: 1px solid #2a3d4d; background: #101c26; overflow: hidden; }
      .hud-status-fill { height: 100%; width: 0; background: var(--ui-accent); }
      .hud-status-fill.warning { background: var(--ui-warn); }
      .hud-status-fill.danger { background: var(--ui-danger); }
      .hud-status-text { font-family: var(--ui-mono); font-size: 9px; color: #9fb4c4; text-align: right; }
      .hud-mode-badge, .hud-action-group { border: 1px solid #2a3d4d; padding: 3px 6px; color: #9fb4c4;
        font-family: var(--ui-mono); font-size: 9px; letter-spacing: 1px; text-align: center; }
      .hud-mode-badge.precision { border-color: var(--ui-accent); color: var(--ui-accent); }
      .hud-action-group { border-color: var(--ui-warn); color: var(--ui-warn); }
      .hud-part-popup { position: absolute; width: 220px; background: rgba(8,14,20,0.97); border: 1px solid var(--ui-accent);
        padding: 8px; z-index: 54; pointer-events: auto; box-shadow: 0 8px 30px rgba(0,0,0,0.4); }
      .hud-part-heading { display: flex; align-items: center; gap: 8px; color: #eef5f8; font-size: 12px; margin-bottom: 5px; }
      .hud-part-heading strong { flex: 1; }
      .hud-part-meta { color: #8fa4b4; font-family: var(--ui-mono); font-size: 9.5px; line-height: 1.5; margin-bottom: 5px; }
      .hud-part-action { width: 100%; text-align: left; margin-top: 4px; font-size: 10.5px; }
      .hud-readouts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .hud-readout { background: var(--ui-bg); border: 1px solid #223240; border-radius: 6px; padding: 4px 10px; min-width: 110px; }
      .hud-readout-label { font-size: 9px; letter-spacing: 1.5px; color: #7d8b96; }
      .hud-readout-value { font-family: var(--ui-mono); font-size: 15px; }
      .hud-right { position: absolute; right: 12px; top: 56px; display: flex; flex-direction: column; gap: 8px;
        width: 230px; pointer-events: auto; }
      .hud-panel { background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .hud-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; padding: 1px 0; }
      .hud-key { color: #7d8b96; font-size: 11px; min-width: 34px; }
      .k-simple-terms .hud-key-ap::after { content: ' / highest'; font-size: 8px; }
      .k-simple-terms .hud-key-pe::after { content: ' / lowest'; font-size: 8px; }
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
      .hud-stage-metrics { color: #d8e2ea; font-family: var(--ui-mono); font-size: 10px; margin-top: 2px; }
      .hud-entry-card { border-color: #9c553d; }
      .hud-entry-card.warning { border-color: var(--ui-warn); }
      .hud-entry-card .hud-key { min-width: 52px; }
      .hud-entry-card .hud-val { margin-left: auto; font-size: 10.5px; }
      .hud-events { position: absolute; left: 12px; top: 88px; display: flex; flex-direction: column; gap: 4px; max-width: 320px; }
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
      .map-alarm-row { gap: 3px; }
      .map-alarm-row button { padding: 2px 6px; font-size: 9px; }
      .map-node-panel { display: flex; flex-direction: column; gap: 6px; }
      .map-axis { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .map-axis label { width: 66px; color: #9fb4c4; font-size: 11px; }
      .map-axis input[type=range] { flex: 1; }
      .map-axis .val { font-family: var(--ui-mono); width: 64px; text-align: right; }
      .map-axis button { width: 24px; padding: 2px; }
      .map-number { min-width: 0; width: 92px; background: #101c26; border: 1px solid #2a3d4d;
        color: #d8e2ea; font-family: var(--ui-mono); font-size: 11px; padding: 3px 5px; text-align: right; }
      .map-step-row, .map-snap-row { display: flex; gap: 4px; align-items: center; margin-bottom: 2px; }
      .map-step-row button, .map-snap-row button { padding: 2px 7px; font-size: 10px; }
      .map-step-row button.active { border-color: var(--ui-accent); color: var(--ui-accent); }
      .map-step-label { color: #7d8b96; font-size: 9px; letter-spacing: 1px; min-width: 54px; }
      .map-readout { font-family: var(--ui-mono); font-size: 12px; color: var(--ui-accent); padding: 2px 0; }
      .map-orbit-after { font-family: var(--ui-mono); font-size: 10.5px; color: #b7c8d4; white-space: pre-line;
        border-top: 1px solid #223240; margin-top: 5px; padding-top: 5px; }
      .map-budget { font-family: var(--ui-mono); font-size: 10.5px; color: var(--ui-good); padding-top: 4px; }
      .map-budget.warning { color: var(--ui-danger); }
      .map-encounter { font-family: var(--ui-mono); font-size: 12px; color: #c88be8; white-space: pre-line; padding-top: 4px; }
      .map-entry-info { font-family: var(--ui-mono); font-size: 10px; color: #e27a4f; padding-top: 4px; }
      .map-body-card { position: absolute; width: 190px; display: flex; flex-direction: column; gap: 4px;
        background: rgba(8,14,20,0.97); border: 1px solid var(--ui-accent); padding: 8px; z-index: 54; pointer-events: auto; }
      .map-body-card strong { color: #eef5f8; font-size: 12px; }
      .map-body-card > span { color: #8195a4; font-family: var(--ui-mono); font-size: 9.5px; }
      .map-body-card .map-row { margin: 3px 0 0; }
      .map-body-card .k-window-btn { position: absolute; right: 4px; top: 3px; }

      /* ============================== mission tools */
      .mission-alarm-form { display: grid; grid-template-columns: 1fr 66px 82px auto; gap: 4px; margin-bottom: 8px; }
      .mission-input { min-width: 0; background: #101c26; border: 1px solid #2a3d4d; color: #d8e2ea;
        font-size: 10.5px; padding: 3px 5px; }
      .mission-list { display: flex; flex-direction: column; gap: 5px; max-height: 300px; overflow-y: auto; }
      .mission-empty { color: #6f8290; font-size: 10.5px; padding: 8px 0; text-align: center; }
      .mission-row { display: flex; align-items: center; gap: 6px; border-top: 1px solid #1d2b35; padding-top: 5px; }
      .mission-kind { color: var(--ui-accent); width: 16px; text-align: center; }
      .mission-row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .mission-row-info strong { color: #d8e2ea; font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mission-row-info span { color: #7d8b96; font-family: var(--ui-mono); font-size: 9px; }
      .mission-alarm-banner { position: absolute; top: 62px; left: 50%; transform: translateX(-50%); display: flex;
        align-items: center; gap: 10px; background: rgba(18,14,7,0.97); border: 1px solid var(--ui-warn);
        padding: 8px 10px; z-index: 58; pointer-events: auto; box-shadow: 0 8px 28px rgba(0,0,0,0.45); }
      .mission-alarm-icon { color: var(--ui-warn); font-size: 22px; }
      .mission-alarm-copy { display: flex; flex-direction: column; min-width: 160px; }
      .mission-alarm-copy strong { color: var(--ui-warn); font-size: 10px; letter-spacing: 2px; }
      .mission-alarm-copy span { color: #e4dccb; font-size: 11px; }
      .mission-alarm-actions { display: flex; gap: 4px; }
      .mission-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: #7d8b96; font-size: 9px; margin-bottom: 6px; }
      .transfer-list { max-height: 380px; }
      .transfer-row { display: grid; grid-template-columns: 38px 1fr; gap: 7px; border: 1px solid #223240; padding: 6px; }
      .transfer-row.targeted { border-color: #d56ba9; }
      .phase-dial { position: relative; width: 34px; height: 34px; border: 1px solid #405364; border-radius: 50%; align-self: center; }
      .phase-needle { position: absolute; left: 16px; bottom: 16px; width: 1px; height: 14px; transform-origin: 50% 100%; background: var(--ui-accent); }
      .phase-needle.needed { background: var(--ui-warn); }
      .transfer-info { display: flex; flex-direction: column; min-width: 0; }
      .transfer-info strong { color: #d8e2ea; font-size: 11px; }
      .transfer-info span { color: #8599a8; font-family: var(--ui-mono); font-size: 9px; }
      .transfer-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 4px; }
      .transfer-actions button { padding: 2px 6px; font-size: 9px; }
      .mission-section-title { color: #7d8b96; font-size: 9px; letter-spacing: 1.5px; margin: 3px 0 5px; }
      .mission-fleet-header { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #223240; margin-top: 8px; padding-top: 5px; }
      .mission-check { color: #7d8b96; font-size: 9px; }
      .body-list { max-height: 150px; }
      .body-row button, .fleet-row button { padding: 2px 6px; font-size: 9px; }
      .body-row button.active { border-color: #d56ba9; color: #ef9acb; }
      .fleet-list { max-height: 260px; }
      .fleet-row.active { border-left: 2px solid var(--ui-accent); padding-left: 5px; }
      .fleet-name { width: 100%; border: 0; border-bottom: 1px solid transparent; background: transparent; color: #d8e2ea; font-size: 10.5px; padding: 0; }
      .fleet-name:focus { outline: 0; border-bottom-color: var(--ui-accent); }

      /* ============================== workshop editor */
      .ed-root { position: absolute; inset: 0; pointer-events: none; }
      .ed-root button, .ed-root input, .ed-root select { pointer-events: auto; }
      .ed-left { position: absolute; left: 0; top: 0; bottom: 0; width: 244px;
        background: rgba(10,16,22,0.94); border-right: 1px solid #223240;
        display: flex; flex-direction: column; pointer-events: auto; }
      .ed-title { padding: 10px 12px 4px; font-size: 15px; letter-spacing: 3px; color: var(--ui-accent); }
      .ed-cats { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 8px; }
      .ed-palette-tools { display: grid; grid-template-columns: 1fr 76px; gap: 4px; padding: 0 8px 5px; }
      .ed-search, .ed-sort { min-width: 0; background: #101c26; border: 1px solid #2a3d4d; color: #d8e2ea;
        font-size: 10.5px; padding: 4px 6px; }
      .ed-cat { font-size: 10px; padding: 3px 7px; }
      .ed-cat.active { border-color: var(--ui-accent); background: #16303f; }
      .ed-parts { flex: 1; overflow-y: auto; padding: 4px 8px; display: flex; flex-direction: column; gap: 4px; }
      .ed-part { border: 1px solid #223240; border-radius: 6px; padding: 5px; cursor: pointer;
        background: rgba(20,30,40,0.6); display: grid; grid-template-columns: 56px 1fr; gap: 7px; }
      .ed-part:hover { border-color: var(--ui-accent); }
      .ed-part-thumb { width: 56px; height: 56px; background: #0d1720; border: 1px solid #1d2b35; }
      .ed-part-copy { min-width: 0; }
      .ed-part-name { font-size: 12px; color: #d8e2ea; }
      .ed-part-info { font-size: 10px; color: #7d8b96; }
      .ed-part-blurb { font-size: 9.5px; color: #91a3b0; line-height: 1.25; margin-top: 3px; display: -webkit-box;
        -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
      .ed-right { position: absolute; right: 0; top: 0; bottom: 0; width: 268px;
        background: rgba(10,16,22,0.94); border-left: 1px solid #223240;
        display: flex; flex-direction: column; gap: 8px; padding: 10px; overflow-y: auto; pointer-events: auto; }
      .ed-panel { border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .ed-panel h3 { font-size: 10px; letter-spacing: 2px; color: #9fb4c4; margin-bottom: 6px; font-weight: normal; }
      .ed-stats { font-size: 11px; }
      .ed-engineering-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; }
      .ed-engineering-key { color: #7d8b96; font-size: 10px; }
      .ed-engineering-value { color: #d8e2ea; font-family: var(--ui-mono); text-align: right; }
      .ed-engineering-stages { border-top: 1px solid #223240; margin-top: 6px; padding-top: 4px; }
      .ed-engineering-stage { display: flex; gap: 8px; font-family: var(--ui-mono); font-size: 9.5px; color: #9fb4c4; }
      .ed-engineering-stage strong { color: var(--ui-accent); min-width: 22px; }
      .ed-warn { color: var(--ui-warn); font-size: 11px; padding: 2px 0; }
      .ed-warn.linked { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
      .ed-stage { border: 1px solid #223240; border-radius: 5px; padding: 4px 6px; margin-bottom: 4px; font-size: 11px; }
      .ed-stage[draggable=true] { cursor: grab; }
      .ed-unstaged { border-style: dashed; }
      .ed-stage-head { display: flex; gap: 4px; align-items: center; color: #9fb4c4; font-size: 10px; }
      .ed-stage-head > span:first-child { min-width: 50px; }
      .ed-stage-metrics { flex: 1; color: #b7c8d4; font-family: var(--ui-mono); font-size: 9px; }
      .ed-stage-head button { padding: 0 6px; font-size: 10px; }
      .ed-stage-parts { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; min-height: 20px; }
      .ed-stage-part { background: #132431; border: 1px solid #2a4658; color: #c5d3dc; padding: 2px 5px;
        font-size: 9px; cursor: grab; }
      .ed-topbar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 8px; align-items: center; pointer-events: auto;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 6px 12px; }
      .ed-name { background: #101c26; border: 1px solid #2a3d4d; color: var(--ui-fg);
        border-radius: 5px; padding: 4px 8px; width: 190px; font-size: 13px; }
      .ed-launch { border-color: var(--ui-good) !important; color: var(--ui-good) !important; font-weight: bold; }
      .ed-launch:disabled { border-color: #34434e !important; color: #788791 !important; }
      .ed-hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
        background: var(--ui-bg); border-radius: 6px; padding: 4px 14px; font-size: 11px; color: #9fb4c4; }
      .ed-craft-list { display: flex; flex-direction: column; gap: 3px; }
      .ed-craft-item { display: flex; gap: 4px; align-items: center; border-top: 1px solid #1d2b35; padding-top: 4px; }
      .ed-craft-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .ed-craft-copy strong { color: #d8e2ea; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ed-craft-copy span { color: #748794; font-family: var(--ui-mono); font-size: 8.5px; }
      .ed-craft-item button { font-size: 11px; }
      .ed-built-in-panel { border-color: #34566b; background: linear-gradient(135deg, rgba(22,48,63,0.55), rgba(10,16,22,0.2)); }
      .ed-built-in-craft { border-left: 2px solid var(--ui-accent); padding-left: 6px; }
      .ed-part-context { position: absolute; left: 254px; bottom: 52px; width: 245px; background: rgba(8,14,20,0.97);
        border: 1px solid var(--ui-accent); padding: 8px; z-index: 42; pointer-events: auto; }
      .ed-part-context-meta { color: #7d8b96; font-family: var(--ui-mono); font-size: 9px; margin-bottom: 5px; }
      .ed-part-context-actions, .ed-action-groups { display: flex; flex-wrap: wrap; gap: 4px; }
      .ed-action-select { float: right; background: #101c26; border: 1px solid #2a3d4d; color: #c9d6df; font-size: 8px; }
      .ed-part-context-actions button { padding: 2px 6px; font-size: 9.5px; }
      .ed-action-groups button { width: 25px; padding: 2px; font-size: 9px; }
      .ed-action-groups button.active { border-color: var(--ui-accent); color: var(--ui-accent); background: #16303f; }

      /* ============================== science, saves, log, settings */
      .utility-total { color: var(--ui-accent); font-family: var(--ui-mono); font-size: 10px; margin-bottom: 7px; }
      .utility-section { border-top: 1px solid #223240; padding: 6px 0; }
      .utility-heading { color: #d8e2ea; font-size: 10.5px; }
      .utility-muted { color: #7d8b96; font-size: 9px; line-height: 1.35; }
      .utility-row { color: #aebfca; font-family: var(--ui-mono); font-size: 9px; padding: 2px 0; }
      .utility-remaining { color: var(--ui-warn); font-size: 8.5px; margin-top: 3px; }
      .utility-science-card { display: flex; flex-direction: column; border-left: 2px solid var(--ui-accent);
        background: #101c26; padding: 5px 7px; margin-top: 4px; }
      .utility-science-card strong { color: #e3edf2; font-size: 10px; }
      .utility-science-card span { color: var(--ui-accent); font-family: var(--ui-mono); font-size: 8.5px; }
      .utility-science-card em { color: #8195a3; font-size: 8.5px; font-style: normal; }
      .utility-create { display: grid; grid-template-columns: 1fr auto; gap: 5px; margin-bottom: 7px; }
      .k-input, .k-select { min-width: 0; background: #101c26; border: 1px solid #2a3d4d; color: #d8e2ea;
        font-size: 10px; padding: 4px 6px; }
      .utility-save { border-top: 1px solid #223240; padding: 6px 0; }
      .utility-save-copy { margin-bottom: 4px; }
      .utility-sync { display: inline-block; margin-left: 6px; color: #91a5b2; font: 8px var(--ui-mono); letter-spacing: 0.5px; }
      .utility-sync-synced { color: var(--ui-good); }
      .utility-sync-pending, .utility-sync-conflict { color: var(--ui-warn); }
      .utility-actions { display: flex; gap: 4px; justify-content: flex-end; }
      .utility-actions button { padding: 2px 6px; font-size: 9px; }
      .account-form { display: grid; gap: 5px; border-top: 1px solid #223240; margin-top: 8px; padding-top: 7px; }
      .account-email { color: var(--ui-accent); font: 10px var(--ui-mono); margin: 4px 0 7px; overflow-wrap: anywhere; }
      .account-submit { justify-self: end; margin-top: 3px; }
      .account-error { min-height: 16px; color: var(--ui-danger); font-size: 9px; padding-top: 5px; }
      .account-error-empty { visibility: hidden; }
      .utility-log { display: grid; grid-template-columns: 58px 1fr; gap: 6px; padding: 4px 0;
        border-top: 1px solid #1c2b35; color: #bccbd5; font-size: 9px; }
      .utility-log.warning { color: var(--ui-warn); }
      .utility-log.danger { color: var(--ui-danger); }
      .utility-time { color: #6f8493; font-family: var(--ui-mono); }
      .utility-setting { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
        color: #b8c7d1; font-size: 9.5px; padding: 3px 0; }
      .utility-setting input[type=range] { grid-column: 1 / -1; width: 100%; accent-color: var(--ui-accent); }
      .utility-setting-value { color: var(--ui-accent); font-family: var(--ui-mono); }
      .utility-bindings { max-height: 210px; overflow-y: auto; border-top: 1px solid #223240; }
      .utility-binding { display: grid; grid-template-columns: 1fr 86px; gap: 6px; align-items: center;
        color: #aebfca; font-size: 9px; padding: 2px 0; }
      .utility-binding button { padding: 2px 4px; font-size: 8.5px; }
      .utility-reset { margin-top: 6px; font-size: 9px; }
      .k-reduced-motion *, .k-reduced-motion *::before, .k-reduced-motion *::after {
        animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important;
      }

      @media (max-width:820px), (pointer:coarse) {
        .k-icon-btn { width:42px; height:42px; }
        .ed-utility-host .k-launcher,.hud-utility-host .k-launcher { gap:2px; }
      }

      /* main menu */
      .perilune-menu { position:absolute; inset:0; overflow:hidden; z-index:40; pointer-events:auto;
        background:#03080d url('/ui/perilune-command-deck-bg.jpg') 72% center/cover no-repeat; }
      .perilune-menu-vignette { position:absolute; inset:0; background:
        linear-gradient(90deg,rgba(2,7,12,.86) 0%,rgba(2,7,12,.30) 52%,rgba(2,7,12,.15)),
        linear-gradient(0deg,rgba(2,7,12,.72),transparent 42%); }
      .perilune-menu-masthead { position:absolute; left:clamp(28px,6vw,96px); top:clamp(54px,11vh,116px); }
      .perilune-menu-eyebrow { color:#9fb5c2; font-size:10px; letter-spacing:3px; }
      .perilune-menu-logo { margin:9px 0 0; color:#a1dcf2; font-size:clamp(44px,6vw,82px); line-height:.92;
        font-weight:300; letter-spacing:clamp(10px,1.6vw,22px); text-shadow:0 5px 24px rgba(50,151,195,.28); }
      .perilune-menu-tagline { margin-top:14px; max-width:420px; color:#c0ccd2; font-size:12px; letter-spacing:.7px; }
      .perilune-menu-build { position:absolute; top:28px; right:34px; color:#8da3af; font:9px var(--ui-mono); letter-spacing:1.5px; }
      .perilune-command-deck { position:absolute; left:3.5vw; right:3.5vw; bottom:4vh; display:grid;
        grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr) auto; gap:8px;
        padding:10px; background:linear-gradient(180deg,rgba(9,18,26,.86),rgba(5,11,17,.95));
        border:1px solid rgba(100,163,193,.5); border-top-color:#73bfdf; backdrop-filter:blur(12px);
        box-shadow:0 18px 50px rgba(0,0,0,.42); animation:menuDeckIn .45s ease-out both; }
      .perilune-mission { min-height:76px; padding:12px 14px; text-align:left; color:#e8f0f3;
        border:1px solid #345267; background:rgba(10,23,33,.68); cursor:pointer; }
      .perilune-mission:hover { border-color:#8ed1ec; transform:translateY(-1px); }
      .perilune-mission:focus-visible { border-color:#8ed1ec; outline:2px solid #f4c15f;
        outline-offset:3px; transform:translateY(-1px); }
      .perilune-mission-primary { border-color:#dca94a; background:linear-gradient(120deg,rgba(121,75,24,.56),rgba(28,36,39,.76)); }
      .perilune-mission-eyebrow { display:block; color:#8fa7b4; font-size:8px; letter-spacing:2px; }
      .perilune-mission-title { display:block; margin-top:5px; font-size:14px; letter-spacing:.8px; }
      .perilune-mission-detail { display:block; margin-top:5px; color:#9fadb4; font-size:9px; }
      .perilune-menu-utilities { grid-column:4; display:flex; align-items:center; gap:6px; padding:0 4px 0 10px; border-left:1px solid #29404f; }
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
