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
      .k-window { position:absolute; min-width:190px; min-height:84px; max-width:340px;
        display:flex; flex-direction:column; container-type:inline-size; overflow:hidden;
        background: rgba(10,16,22,0.94); border: 1px solid #2a3d4d; border-radius: 8px;
        z-index: 45; pointer-events: auto; }
      .k-window-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
        cursor: grab; border-bottom: 1px solid #1a2833; user-select: none; }
      .k-window-title { flex: 1; font-size: 10px; letter-spacing: 2px; color: #9fb4c4; }
      .k-window-btn { background: none; border: none; color: #7d8b96; cursor: pointer;
        font-size: 12px; padding: 0 3px; }
      .k-window-btn:hover { color: #fff; }
      .k-window-content { flex:1 1 auto; min-height:0; padding:8px 10px; overflow:auto; }
      .k-window-resize-handle { position:absolute; z-index:2; right:1px; bottom:1px; width:18px; height:18px;
        cursor:nwse-resize; touch-action:none; opacity:.65; }
      .k-window-resize-handle::after { content:''; position:absolute; right:4px; bottom:4px; width:8px; height:8px;
        border-right:2px solid #7893a2; border-bottom:2px solid #7893a2; }
      .k-window-resize-handle:hover,.k-window-resize-handle:focus-visible { opacity:1; outline:none; }
      .k-window.collapsed { min-height:0 !important; height:auto !important; }
      .k-window.collapsed .k-window-resize-handle { display:none; }
      .k-instrument-grid { display: grid; grid-template-columns: auto minmax(80px, 1fr); gap: 3px 14px; }
      .k-instrument-key { color: #7d8b96; font-size: 10.5px; }
      .k-instrument-value { color: #d8e2ea; font-family: var(--ui-mono); font-size: 11.5px; text-align: right; }
      .k-spotlight { position: fixed; border: 2px solid var(--ui-warn); border-radius: 8px;
        box-shadow:0 0 0 3px rgba(226,177,60,.12),0 0 20px rgba(226,177,60,.52);
        pointer-events: none; z-index: 55;
        transition: left 0.15s ease-out, top 0.15s ease-out, width 0.15s ease-out, height 0.15s ease-out;
        display: none; }
      .k-spotlight::after { content:'CURRENT CONTROL'; position:absolute; left:-2px; bottom:calc(100% + 7px);
        padding:3px 6px; border:1px solid rgba(226,177,60,.7); border-radius:3px;
        background:rgba(17,19,14,.96); color:#f0d17d; font:700 7px var(--ui-mono); letter-spacing:1px;
        white-space:nowrap; box-shadow:0 4px 14px rgba(0,0,0,.32); }
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
      .game-dialog { position:absolute; z-index:80; left:50%; top:50%; width:min(420px,calc(100vw - 28px));
        max-height:calc(100dvh - 28px); box-sizing:border-box; overflow-y:auto; transform:translate(-50%,-50%);
        padding:18px 20px; border:1px solid var(--ui-accent); border-radius:10px;
        background:rgba(14,24,32,.97); pointer-events:auto; box-shadow:0 18px 54px rgba(0,0,0,.48); }
      .game-dialog-title { margin-bottom:6px; color:#fff; font-size:17px; }
      .game-dialog-message { margin-bottom:14px; color:#c4d2dd; font-size:13px; line-height:1.5;
        white-space:pre-line; }
      .game-dialog-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .game-dialog-actions .hud-btn { width:100%; min-height:38px; padding:7px 9px; white-space:normal; }
      .hud-top { position:absolute; z-index:12; top:8px; left:50%; transform:translateX(-50%);
        width:min(1040px,calc(100vw - 24px)); display:grid; gap:5px; padding:5px 8px;
        background:linear-gradient(180deg,rgba(8,18,25,.97),rgba(5,12,18,.94));
        border:1px solid #2c4758; border-radius:8px; pointer-events:auto;
        box-shadow:0 9px 28px rgba(0,0,0,.28); }
      .hud-meta { min-width:0; display:grid;
        grid-template-columns:max-content minmax(76px,max-content) minmax(90px,max-content)
          minmax(150px,220px) max-content max-content;
        gap:10px; align-items:center; justify-content:space-between; }
      .hud-met { min-width:90px; padding-right:10px; border-right:1px solid #294252;
        font-family:var(--ui-mono); font-size:14px; color:var(--ui-accent); }
      .hud-next-alarm { width:max-content; white-space:nowrap;
        font-family:var(--ui-mono); font-size:10px; color:var(--ui-warn); }
      .hud-situation { font-size: 12px; letter-spacing: 2px; color: #9fb4c4; min-width: 90px; text-align: center; }
      .hud-crew { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: #b7c8d4; font-size: 10px; letter-spacing: 1px; }
      .hud-warp { min-width:34px; text-align:center;
        font-family:var(--ui-mono); font-size:13px; color:var(--ui-warn); }
      .hud-warp-group { display:flex; align-items:center; justify-content:flex-end; gap:5px; }
      .hud-warp-btns { display: flex; gap: 4px; }
      .hud-vessel-control { min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr) auto;
        align-items:center; gap:6px; padding-left:8px; border-left:1px solid #294252; }
      .hud-vessel-label { color:#6f8c9b; font:7px var(--ui-mono); letter-spacing:1.2px; }
      .hud-vessel-select { min-width:0; width:100%; height:26px; border:1px solid #315065; border-radius:4px;
        background:#091720; color:#dce9ee; padding:0 6px; font:10px var(--ui-mono); }
      .hud-vessel-select:disabled { opacity:.72; }
      .hud-comms { color:#7d8b96; font:8px var(--ui-mono); white-space:nowrap; }
      .hud-sys { position:static; display:flex; justify-content:flex-start; gap:5px; min-width:0;
        padding-top:5px; border-top:1px solid #1d3340; overflow-x:auto; scrollbar-width:none; }
      .hud-sys::-webkit-scrollbar { display:none; }
      .hud-sys .hud-btn { flex:0 0 auto; white-space:nowrap; }
      .hud-orbit-strip { flex:0 0 auto; display:flex; align-items:center; gap:4px; }
      .hud-apsis-indicator { width:104px; min-height:29px; box-sizing:border-box;
        display:grid; grid-template-columns:18px minmax(0,1fr); grid-template-rows:1fr 1fr;
        grid-template-areas:'label value' 'label eta'; align-items:center; column-gap:4px; padding:3px 6px;
        border:1px solid #315064; border-radius:5px; background:rgba(7,17,24,.82); }
      .hud-apsis-label { grid-area:label; color:#7f99a8; font:10px var(--ui-mono); }
      .hud-apsis-value { grid-area:value; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        color:#dce9ee; font:700 11px var(--ui-mono); }
      .hud-apsis-eta { grid-area:eta; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        color:#748c99; font:8px var(--ui-mono); }
      .hud-resource-strip { flex:0 0 auto; display:flex; align-items:center; gap:4px; margin-right:2px; }
      .hud-resource-indicator { position:relative; width:86px; min-height:27px; box-sizing:border-box;
        display:grid; grid-template-columns:16px minmax(18px,1fr) 28px; align-items:center; gap:3px;
        padding:3px 5px; border:1px solid #294453; border-radius:5px; background:rgba(7,17,24,.82);
        color:#8eabb9; outline:none; }
      .hud-resource-indicator:hover,.hud-resource-indicator:focus-visible { border-color:var(--ui-accent); color:#eaf5f8; }
      .hud-resource-icon { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6;
        stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
      .hud-resource-indicator.charge .hud-resource-icon { color:#e1b94f; }
      .hud-resource-indicator.monoprop .hud-resource-icon { color:#87c5dd; }
      .hud-resource-track { height:5px; overflow:hidden; border-radius:3px; background:#101f29; }
      .hud-resource-fill { width:0; height:100%; background:var(--ui-accent); }
      .hud-resource-value { min-width:0; overflow:hidden; color:#a9bdc7; font:8px var(--ui-mono); text-align:right; }
      .hud-resource-tooltip { position:absolute; left:50%; top:calc(100% + 7px); z-index:72;
        transform:translate(-50%,-4px); visibility:hidden; opacity:0; pointer-events:none; white-space:nowrap;
        padding:5px 7px; border:1px solid #49677a; border-radius:4px; background:#08131b;
        color:#eaf3f7; font:10px var(--ui-mono); transition:opacity .12s ease,transform .12s ease; }
      .hud-resource-indicator:hover .hud-resource-tooltip,
      .hud-resource-indicator:focus-visible .hud-resource-tooltip { visibility:visible; opacity:1; transform:translate(-50%,0); }
      .hud-main { min-width:64px; font-size:13px; }
      .hud-recover { margin-left:5px; border-color:var(--ui-good); }
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
      .hud-sas { position:absolute; z-index:7; left:-96px; top:34px; width:74px; padding:5px;
        display:none; grid-template-columns:1fr 1fr; gap:4px;
        background:linear-gradient(180deg,rgba(9,19,27,.97),rgba(5,12,18,.97));
        border:1px solid #38566a; border-radius:6px 2px 2px 6px; box-shadow:0 8px 24px rgba(0,0,0,.36); }
      .hud-sas.open { display:grid; }
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
      .hud-nav-controls { position:absolute; z-index:6; inset:0; pointer-events:none; }
      .hud-nav-toggle { border:1px solid #354f60; border-radius:3px; background:#0b1821; color:#7e96a4;
        font:700 10px var(--ui-mono); letter-spacing:1px; cursor:pointer; }
      .hud-nav-toggle { position:absolute; top:5px; width:46px; height:46px; border-radius:50%; pointer-events:auto;
        box-shadow:inset 0 0 13px rgba(0,0,0,.48),0 4px 12px rgba(0,0,0,.36); }
      .hud-nav-toggle:first-child { left:-8px; }
      .hud-nav-toggle:nth-child(2) { right:-8px; }
      .hud-nav-toggle:hover,.hud-nav-toggle:focus-visible { border-color:var(--ui-accent); color:#fff; }
      .hud-nav-toggle.active { border-color:#7fb8a4; background:#173329; color:#bfe9d8;
        box-shadow:inset 0 0 10px rgba(73,164,130,.18); }
      .hud-nav-guidance-mode { position:absolute; left:50%; bottom:-12px; min-width:104px; min-height:27px;
        transform:translateX(-50%); display:grid; place-items:center; padding:0 10px; pointer-events:auto;
        border:1px solid #526d7d; border-radius:14px; background:#091720; color:#b8c9d2;
        font:8px var(--ui-mono); letter-spacing:.8px; white-space:nowrap; cursor:pointer; }
      .hud-nav-guidance-mode:hover,.hud-nav-guidance-mode:focus-visible { border-color:var(--ui-accent); color:#fff; }
      .hud-throttle-range { position:absolute; z-index:8; left:-67px; top:80px; width:170px; height:64px;
        margin:0; transform:rotate(-90deg); opacity:0; cursor:ns-resize; touch-action:none;
        -webkit-appearance:none; appearance:none; }
      .hud-navwrap:has(.hud-throttle-range:focus-visible) .hud-navball { outline:2px solid var(--ui-warn);
        outline-offset:3px; border-radius:50%; }
      .hud-status-strip { position:static; width:auto; display:flex; flex-direction:column; gap:5px; }
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
      .hud-right { position:absolute; right:12px; top:106px; display:flex; flex-direction:column; gap:6px;
        width: 230px; pointer-events: auto; }
      .hud-data-toggle { min-height:34px; border:1px solid #315064; border-radius:6px; background:rgba(7,16,23,.94);
        color:#9fb4c4; font:9px var(--ui-mono); letter-spacing:1px; cursor:pointer; text-align:left; padding:0 10px; }
      .hud-data-toggle:hover,.hud-data-toggle:focus-visible { border-color:var(--ui-accent); color:#e8f4f7; }
      .hud-details-collapsed .hud-detail-panel { display:none !important; }
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
      .hud-science-status { border-color: #315267; background: linear-gradient(135deg, rgba(13,34,46,.96), rgba(7,16,23,.96)); }
      .hud-science-kicker { color: #8fa7b4; font: 8px var(--ui-mono); letter-spacing: 1.7px; }
      .hud-science-available { margin-top: 3px; color: var(--ui-accent); font: 10px var(--ui-mono); }
      .hud-science-aboard { margin-top: 2px; color: #9fb4c4; font: 8.5px var(--ui-mono); }
      .hud-systems { display: flex; flex-direction: column; gap: 4px; }
      .hud-sys-toggle { width: 100%; text-align: left; font-size: 11px; }
      .hud-sys-toggle.active { border-color: var(--ui-good); color: #cfe8d6; }
      .hud-stages { width:200px; align-self:flex-end; box-sizing:border-box; max-height:40vh; overflow-y:auto; }
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
      .hud-companion { position:absolute; z-index:14; left:50px; bottom:16px; display:flex;
        align-items:flex-end; gap:9px; max-width:min(390px,calc(100vw - 68px)); pointer-events:auto; }
      .hud-companion-avatar { position:relative; flex:0 0 58px; width:58px; height:64px; padding:4px 5px 3px;
        display:flex; flex-direction:column; align-items:center; justify-content:center; overflow:hidden;
        border:1px solid #42657a; border-radius:15px 15px 10px 10px;
        background:linear-gradient(155deg,#163242,#08151e 70%); color:#a9d7e7; cursor:pointer;
        box-shadow:0 10px 28px rgba(0,0,0,.38),inset 0 1px rgba(174,224,240,.12); }
      .hud-companion-avatar:hover,.hud-companion-avatar:focus-visible { border-color:var(--ui-accent); color:#e9f8fc;
        transform:translateY(-2px); }
      .hud-companion-avatar:focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
      .hud-companion-mark { width:46px; height:46px; overflow:visible; }
      .pip-shell { fill:#163849; stroke:#72b4ce; stroke-width:2; }
      .pip-glass { fill:#08151d; stroke:#4f8198; stroke-width:1.5; }
      .pip-brow,.pip-smile,.pip-ear,.pip-antenna { fill:none; stroke:currentColor; stroke-width:2;
        stroke-linecap:round; stroke-linejoin:round; }
      .pip-eye { fill:#f0c75a; stroke:none; }
      .hud-companion-nameplate { margin-top:-2px; color:#80a7b8; font:700 7px var(--ui-mono); letter-spacing:2px; }
      .hud-companion-bubble { position:relative; order:2; min-width:220px; max-width:300px; overflow:visible;
        border:1px solid #3c6074; border-radius:11px 11px 11px 3px;
        background:linear-gradient(160deg,rgba(13,31,42,.98),rgba(6,15,22,.98));
        box-shadow:0 14px 38px rgba(0,0,0,.42); animation:hudCompanionIn .18s ease-out both; }
      .hud-companion-bubble::before { content:''; position:absolute; left:-7px; bottom:12px; width:12px; height:12px;
        border-left:1px solid #3c6074; border-bottom:1px solid #3c6074; background:#091822;
        transform:rotate(45deg); }
      .hud-companion-bubble.warning { border-color:#8e7131; }
      .hud-companion-bubble.danger { border-color:#9b4d46; }
      .hud-companion-bubble.success { border-color:#477d68; }
      .hud-companion-header { min-height:25px; display:flex; align-items:center; gap:6px; padding:3px 5px 3px 9px;
        border-bottom:1px solid #213744; background:rgba(13,29,39,.92); }
      .hud-companion-title { flex:1; color:#83a8b9; font:700 7.5px var(--ui-mono); letter-spacing:1.5px; }
      .hud-companion-source { padding:2px 4px; border:1px solid #35596c; border-radius:3px;
        color:#8bc9df; font:700 6.5px var(--ui-mono); letter-spacing:1px; }
      .hud-companion-mute,.hud-companion-close { min-height:23px; border:0; background:none; color:#77909d;
        cursor:pointer; font:700 7px var(--ui-mono); }
      .hud-companion-close { width:22px; padding:0; font-size:15px; line-height:1; }
      .hud-companion-mute:hover,.hud-companion-mute:focus-visible,
      .hud-companion-close:hover,.hud-companion-close:focus-visible { color:#fff; outline:1px solid #55788b; }
      .hud-companion-copy { padding:9px 11px 11px; }
      .hud-companion-headline { display:block; color:#e9f2f5; font-size:12px; letter-spacing:.35px; }
      .hud-companion-bubble.warning .hud-companion-headline { color:#f0d17d; }
      .hud-companion-bubble.danger .hud-companion-headline { color:#f1a29b; }
      .hud-companion-bubble.success .hud-companion-headline { color:#9bd7be; }
      .hud-companion-message { margin:4px 0 0; color:#b7c7ce; font-size:10.5px; line-height:1.45; }
      .hud-companion-action { margin-top:8px; padding:6px 7px; border-left:2px solid var(--ui-accent);
        background:rgba(71,151,181,.08); color:#d9edf4; font:9px/1.4 var(--ui-mono); }
      .hud-companion-footer { display:flex; justify-content:flex-end; padding:0 8px 8px; }
      .hud-companion-brief { min-height:27px; padding:4px 8px; border:1px solid #3a6579; border-radius:4px;
        background:#102936; color:#a8d6e6; cursor:pointer; font:700 7.5px var(--ui-mono); letter-spacing:1.1px; }
      .hud-companion-brief:hover,.hud-companion-brief:focus-visible { border-color:var(--ui-accent); color:#fff;
        outline:1px solid var(--ui-accent); outline-offset:1px; }
      .hud-companion-brief:disabled { cursor:wait; opacity:.62; }
      .hud-companion.message-hidden { max-width:58px; }
      .hud-companion.muted .hud-companion-avatar { opacity:.68; filter:saturate(.55); }
      .hud-companion.muted .pip-eye { transform:scaleY(.28); transform-origin:center; }
      .hud-touch-controls { display:none; }
      @keyframes hudfade { 0% { opacity: 0; } 5% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
      @keyframes hudCompanionIn { from { opacity:0; transform:translate(-5px,4px) scale(.98); }
        to { opacity:1; transform:none; } }

      @media (prefers-reduced-motion:reduce) {
        .hud-companion-bubble { animation:none; }
        .hud-companion-avatar { transition:none; }
      }

      /* ============================== map view */
      .map-panel { position:absolute; z-index:45; left:56px; top:104px; width:292px; max-width:calc(100vw - 64px);
        max-height:calc(100dvh - 116px); display:flex; flex-direction:column; container-type:inline-size;
        overflow:hidden; background:linear-gradient(180deg,rgba(8,19,27,.98),rgba(5,12,18,.97));
        border:1px solid #36566a; border-radius:7px; pointer-events:auto;
        box-shadow:0 14px 38px rgba(0,0,0,.48),inset 0 1px rgba(151,205,232,.06); }
      .map-panel-bar { flex:0 0 auto; min-height:34px; display:flex; align-items:center; gap:6px; padding:4px 8px;
        cursor:grab; user-select:none; border-bottom:1px solid #203440;
        background:linear-gradient(90deg,#102431,#09151e); touch-action:none; }
      .map-panel-bar:active { cursor:grabbing; }
      .map-title { flex:1; min-width:0; font-size:11px; letter-spacing:2px; color:#9fb4c4; }
      .map-panel-collapse { flex:0 0 auto; min-width:28px; min-height:28px; }
      .map-panel-content { flex:1 1 auto; min-height:0; overflow:auto; padding:8px 9px 11px; }
      .map-panel.collapsed { height:auto !important; }
      .map-panel.collapsed .map-panel-content,.map-panel.collapsed .map-panel-resize { display:none; }
      .map-row { display: flex; gap: 5px; margin-bottom: 7px; }
      .map-panel:not(.has-node) .map-panel-content > .map-row:first-of-type button:not(:first-child) { display: none; }
      .map-panel:not(.has-node) .map-node-summary,.map-panel:not(.has-node) .map-analysis { display:none; }
      .map-empty { display: flex; flex-direction: column; gap: 3px; color: #718694; font-size: 10px;
        border-top: 1px solid #223240; padding-top: 7px; }
      .map-empty strong { color: #b9c9d3; font-size: 11px; font-weight: 500; }
      .map-alarm-row { gap: 3px; }
      .map-alarm-row button { padding: 2px 6px; font-size: 9px; }
      .map-node-queue { display:flex; gap:5px; margin-bottom:7px; overflow-x:auto; scrollbar-width:thin; }
      .map-node-chip { flex:0 0 auto; min-width:76px; display:grid; grid-template-columns:20px 1fr; gap:5px;
        align-items:center; padding:4px 6px; border:1px solid #263e4d; border-radius:4px; background:#091721;
        color:#8ca3b1; text-align:left; cursor:pointer; }
      .map-node-chip:hover,.map-node-chip.active { border-color:#d0ad55; background:#1d2119; color:#f0d787; }
      .map-node-chip.overdue { border-color:#a85545; }
      .map-node-chip-index { font:8px var(--ui-mono); color:#607887; }
      .map-node-chip-copy { display:flex; flex-direction:column; line-height:1.05; }
      .map-node-chip-copy strong { font:9px var(--ui-mono); color:inherit; }
      .map-node-chip-copy small { margin-top:2px; font:7.5px var(--ui-mono); color:#718694; }
      .map-planner-instruction { margin:0 0 8px; padding:7px 8px; border-left:2px solid #496d80;
        background:rgba(55,102,126,.09); color:#aebfc8; font:9.5px/1.45 var(--ui-font); }
      .map-planner-instruction[data-phase="executing"] { border-left-color:var(--ui-accent); color:#d8edf4; }
      .map-planner-instruction[data-phase="complete"] { border-left-color:var(--ui-good); color:#b9dccb; }
      .map-planner-instruction[data-phase="overdue"] { border-left-color:var(--ui-danger); color:#e1aaa2; }
      .map-node-actions { align-items:stretch; flex-wrap:wrap; }
      .map-node-actions .map-action-primary { flex:1 1 104px; text-align:left; padding-left:9px; }
      .map-node-actions .map-action-reset { flex:0 1 auto; }
      .map-node-actions .map-action-warp,.map-node-actions .map-action-auto { flex:1 1 112px; min-height:32px; }
      .map-action-auto.active { border-color:#c99f48; background:#29240f; color:#f0d27d; }
      .map-action-auto.executing { border-color:var(--ui-accent); background:#143140; color:#dff6ff; }
      .map-icon-btn { width:31px; padding:2px; font-size:14px; }
      .map-node-panel { display:flex; flex-direction:column; gap:5px; }
      .map-axis { display:grid; grid-template-columns:92px 27px minmax(72px,1fr) 27px; align-items:center; gap:4px; font-size:11px; }
      .map-axis label { width:auto; color:#9fb4c4; font-size:9px; letter-spacing:.35px; }
      .map-axis-prograde label { color:#d8c36d; }
      .map-axis-normal label { color:#b98ce8; }
      .map-axis-radial label { color:#6baee8; }
      .map-axis-time label { color:#8fa4af; }
      .map-axis input[type=range] { flex: 1; }
      .map-axis .val { font-family: var(--ui-mono); width: 64px; text-align: right; }
      .map-axis button { width:27px; height:27px; padding:2px; }
      .map-number { flex:1; min-width:0; width:92px; background:#101c26; border:1px solid #2a3d4d;
        color:#d8e2ea; font-family:var(--ui-mono); font-size:10px; padding:3px 5px; text-align:right; height:27px; box-sizing:border-box; }
      .map-step-row, .map-snap-row { display: flex; gap: 4px; align-items: center; margin-bottom: 2px; }
      .map-step-row button, .map-snap-row button { padding: 2px 7px; font-size: 10px; }
      .map-step-row button.active { border-color: var(--ui-accent); color: var(--ui-accent); }
      .map-step-label { color: #7d8b96; font-size: 9px; letter-spacing: 1px; min-width: 54px; }
      .map-predicted-outcomes { margin-top:2px; padding:7px 8px 8px; border:1px solid #263d4a;
        border-radius:4px; background:rgba(10,25,34,.68); }
      .map-node-summary { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:0 0 4px;
        border-top:1px solid #223744; }
      .map-readout { font-family:var(--ui-mono); font-size:10px; color:var(--ui-accent); padding:0; }
      .map-readout-eta { color:#8ea3ae; text-align:right; }
      .map-analysis { margin-top:5px; border-top:1px solid #223240; }
      .map-analysis summary { padding:5px 0 2px; color:#6f8490; font:7.5px var(--ui-mono); letter-spacing:.8px; cursor:pointer; }
      .map-orbit-after { font-family: var(--ui-mono); font-size: 10.5px; color: #b7c8d4; white-space: pre-line;
        border-top: 1px solid #223240; margin-top: 5px; padding-top: 5px; }
      .map-budget { font-family: var(--ui-mono); font-size: 10.5px; color: var(--ui-good); padding-top: 4px; }
      .map-budget.warning { color: var(--ui-danger); }
      .map-encounter { font-family: var(--ui-mono); font-size: 12px; color: #c88be8; white-space: pre-line; padding-top: 4px; }
      .map-execution-progress { margin-top:7px; padding-top:6px; border-top:1px solid #223744; }
      .map-execution-progress-label { margin-bottom:4px; color:#9fb6c2; font:8px var(--ui-mono); letter-spacing:.7px; }
      .map-execution-progress-track { height:6px; overflow:hidden; border:1px solid #2b4857; border-radius:4px;
        background:#07131a; }
      .map-execution-progress-fill { width:0; height:100%; border-radius:3px;
        background:linear-gradient(90deg,#4a8fae,var(--ui-accent)); transition:width .12s linear; }
      .map-entry-info { font-family: var(--ui-mono); font-size: 10px; color: #e27a4f; padding-top: 4px; }
      .map-body-card { position: absolute; width: 190px; display: flex; flex-direction: column; gap: 4px;
        background: rgba(8,14,20,0.97); border: 1px solid var(--ui-accent); padding: 8px; z-index: 54; pointer-events: auto; }
      .map-body-card strong { color: #eef5f8; font-size: 12px; }
      .map-body-card > span { color: #8195a4; font-family: var(--ui-mono); font-size: 9.5px; }
      .map-body-card .map-row { margin: 3px 0 0; }
      .map-body-card .k-window-btn { position: absolute; right: 4px; top: 3px; }
      .map-orbit-hover, .map-handle-hover { position: absolute; z-index: 56; pointer-events: none;
        transform: translate(10px,-50%); padding: 4px 7px; border: 1px solid #31556a;
        background: rgba(7,14,20,.94); color: #dbe7ed; font: 9px var(--ui-mono);
        letter-spacing: .35px; white-space: nowrap; box-shadow: 0 5px 18px rgba(0,0,0,.35); }
      .map-orbit-hover { border-color: var(--ui-accent); color: var(--ui-accent); }
      .map-handle-hover { border-color: var(--ui-warn); color: #f2d79d; }
      .map-camera-controls { position:absolute; z-index:44; right:14px; top:104px; display:flex; align-items:center;
        gap:3px; padding:4px; border:1px solid #294556; border-radius:6px; background:rgba(6,15,22,.9);
        pointer-events:auto; box-shadow:0 8px 24px rgba(0,0,0,.32); }
      .map-camera-btn { width:31px; height:29px; border:1px solid #29404e; border-radius:4px; background:#0c1a24;
        color:#a9bdc9; font:13px var(--ui-mono); cursor:pointer; }
      .map-camera-btn:hover,.map-camera-btn:focus-visible { border-color:var(--ui-accent); color:#e8f7ff; outline:none; }
      .map-camera-hint { margin:0 5px 0 4px; color:#627986; font:7.5px var(--ui-mono); letter-spacing:.55px; white-space:nowrap; }

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
      .k-window[data-window-id="transfers"] { width:430px; max-width:min(460px,calc(100vw - 16px)); }
      .k-window[data-window-id="transfers"] .k-window-content { padding:8px; }
      .transfer-list { max-height:430px; display:flex; flex-direction:column; gap:6px; }
      .transfer-row { display:grid; grid-template-columns:48px minmax(0,1fr); gap:8px; border:1px solid #253b49;
        border-left:3px solid #395363; padding:8px; background:linear-gradient(110deg,rgba(14,31,41,.94),rgba(7,16,23,.94)); }
      .transfer-row.targeted { border-color:#b76391; border-left-color:#e17db4; }
      .phase-dial { position:relative; width:44px; height:44px; border:1px solid #536a78; border-radius:50%; align-self:start;
        background:radial-gradient(circle,#0d202b 0 34%,transparent 35%),linear-gradient(90deg,transparent 49%,#203844 50%,transparent 51%); }
      .phase-needle { position:absolute; left:21px; bottom:21px; width:1px; height:18px; transform-origin:50% 100%; background:var(--ui-accent); }
      .phase-needle.needed { background: var(--ui-warn); }
      .transfer-info { min-width:0; display:flex; flex-direction:column; }
      .transfer-heading { display:flex; align-items:center; gap:7px; }
      .transfer-heading strong { color:#e7eff3; font-size:12px; letter-spacing:.3px; }
      .transfer-kind { padding:1px 4px; border:1px solid #385160; color:#78909d; font:7px var(--ui-mono); letter-spacing:.8px; }
      .transfer-window { margin-top:2px; color:#d7b85f; font:8px var(--ui-mono); letter-spacing:.55px; }
      .transfer-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px; margin-top:6px; }
      .transfer-metric { min-width:0; display:flex; flex-direction:column; padding:3px 4px; border-top:1px solid #253c49; background:#091720; }
      .transfer-metric span { color:#607783; font:6.5px var(--ui-mono); letter-spacing:.55px; }
      .transfer-metric strong { margin-top:2px; color:#bdccd3; font:8px var(--ui-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .transfer-accuracy { margin-top:5px; color:#a68755; font:7px var(--ui-mono); letter-spacing:.5px; }
      .transfer-accuracy.refined { color:#70aa87; }
      .transfer-actions { grid-column:1/-1; display:grid; grid-template-columns:auto auto minmax(120px,1fr); gap:5px; }
      .transfer-actions button { padding:3px 7px; font-size:8.5px; }
      .transfer-plan-action { border-color:#49616e; color:#a9bbc4; background:#101d24; }
      .transfer-plan-action.verified { border-color:#9e833d; color:#ecd17c; background:#29250f; }
      .transfer-gate { padding:14px; border:1px solid #314957; background:#0a1821; }
      .transfer-gate strong { color:#d1b667; font:9px var(--ui-mono); letter-spacing:1px; }
      .transfer-gate span { margin-top:5px; color:#8095a1; font-size:9px; line-height:1.45; }
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
      .ed-root { position: absolute; inset: 0; min-height:100dvh; pointer-events: none; }
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
        background: rgba(20,30,40,0.6); display: grid; grid-template-columns: 64px 1fr; gap: 8px; min-height:76px; }
      .ed-part:hover { border-color: var(--ui-accent); }
      .ed-part-thumb { width: 64px; height: 64px; align-self:center; border: 1px solid #29404f; border-radius:4px;
        background:
          linear-gradient(rgba(113,161,187,.08) 1px, transparent 1px),
          linear-gradient(90deg, rgba(113,161,187,.08) 1px, transparent 1px),
          radial-gradient(circle at 48% 42%, #1b2b36 0, #0b141b 72%);
        background-size:16px 16px,16px 16px,100% 100%;
        box-shadow:inset 0 0 18px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.025);
        transition:border-color .14s ease,transform .14s ease,filter .14s ease; }
      .ed-part:hover .ed-part-thumb { border-color:#4f829d; transform:translateY(-1px); filter:brightness(1.07); }
      .ed-part-copy { min-width: 0; }
      .ed-part-name { font-size: 12px; color: #d8e2ea; }
      .ed-part-info { font-size: 10px; color: #7d8b96; }
      .ed-part-blurb { font-size: 9.5px; color: #91a3b0; line-height: 1.25; margin-top: 3px; display: -webkit-box;
        -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
      .ed-right { position: absolute; right: 0; top: 0; bottom: 0; width: 268px;
        background: rgba(10,16,22,0.94); border-left: 1px solid #223240;
        display: flex; flex-direction: column; gap: 8px; padding: 10px; overflow-y: auto; pointer-events: auto; }
      .ed-mobile-group { display:contents; }
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
        display:flex; gap:8px; align-items:center; pointer-events:auto;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 6px 12px; }
      .ed-topbar-primary { display:flex; gap:8px; align-items:center; min-width:0; }
      .ed-topbar-scroll { display:flex; gap:8px; align-items:center; min-width:0; }
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
      .ed-part-context { position: absolute; width: 245px; background: rgba(8,14,20,0.97);
        border: 1px solid var(--ui-accent); border-radius:8px; padding: 8px; z-index: 60; pointer-events: auto;
        box-shadow:0 18px 50px rgba(0,0,0,.48); }
      .ed-part-context-meta { color: #7d8b96; font-family: var(--ui-mono); font-size: 9px; margin-bottom: 5px; }
      .ed-part-context-actions, .ed-action-groups { display: flex; flex-wrap: wrap; gap: 4px; }
      .ed-touch-rotate { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; }
      .ed-touch-rotate-reset { grid-column:1/-1; }
      .ed-action-select { float: right; background: #101c26; border: 1px solid #2a3d4d; color: #c9d6df; font-size: 8px; }
      .ed-part-context-actions button { padding: 2px 6px; font-size: 9.5px; }
      .ed-action-groups button { width: 25px; padding: 2px; font-size: 9px; }
      .ed-action-groups button.active { border-color: var(--ui-accent); color: var(--ui-accent); background: #16303f; }
      .ed-mobile-dock,.ed-mobile-multi { display:none; }
      .ed-notice { position:absolute; left:50%; top:68px; transform:translateX(-50%); z-index:62;
        max-width:min(460px,calc(100vw - 24px)); padding:7px 12px; border:1px solid var(--ui-good);
        border-radius:6px; background:rgba(7,20,20,.95); color:#d9f1e8; font-size:11px; pointer-events:none; }
      .ed-notice.danger { border-color:var(--ui-danger); background:rgba(35,12,10,.96); color:#ffd7cf; }

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

      /* Science archive: bounded research dossier instead of an unbroken list. */
      .k-window[data-window-id="science-archive"],.k-window[data-window-id="program-control"] {
        width:min(680px,calc(100vw - 24px)); max-width:none; overflow:hidden;
        border-color:#355267; background:rgba(7,14,20,.975); box-shadow:0 24px 70px rgba(0,0,0,.48); }
      .k-window[data-window-id="science-archive"] .k-window-bar,
      .k-window[data-window-id="program-control"] .k-window-bar {
        padding:6px 10px; background:linear-gradient(90deg,#102431,#09151e); border-bottom-color:#355267; }
      .science-archive,.program-console { height:min(72vh,640px); max-height:100%; min-height:0; padding:0;
        display:flex; flex-direction:column; overflow:hidden; }
      @container (max-width:520px) {
        .science-archive-header,.program-command-header { grid-template-columns:1fr; gap:8px; padding:9px 10px; }
        .science-archive-title,.program-command-identity { display:none; }
        .science-archive-metrics,.program-command-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .science-search { grid-template-columns:1fr; gap:4px; }
        .science-filter-controls { grid-template-columns:1fr 1fr; }
        .science-aboard-grid,.science-site-grid,.research-program-grid,.contract-operation-grid { grid-template-columns:1fr; }
      }
      .science-archive-header { flex:0 0 auto; display:grid; grid-template-columns:minmax(155px,.8fr) 2fr; gap:14px;
        align-items:center; padding:13px 15px 11px; border-bottom:1px solid #2a4353;
        background:linear-gradient(115deg,rgba(26,62,78,.76),rgba(9,23,32,.92) 62%,rgba(17,33,39,.82)); }
      .science-archive-title { min-width:0; display:flex; flex-direction:column; }
      .science-archive-title span { color:#86a6b6; font:7.5px var(--ui-mono); letter-spacing:2.2px; }
      .science-archive-title strong { margin-top:3px; color:#edf5f7; font:600 16px var(--ui-font); letter-spacing:.45px; }
      .science-archive-metrics { display:grid; grid-template-columns:repeat(4,minmax(72px,1fr)); gap:6px; }
      .science-archive-metric { min-width:0; padding:6px 7px; border:1px solid #315064;
        background:rgba(5,16,23,.66); display:grid; grid-template-columns:1fr auto; align-items:end; }
      .science-archive-metric span { grid-column:1/-1; color:#7893a2; font:7px var(--ui-mono); letter-spacing:1.25px; }
      .science-archive-metric strong { margin-top:2px; color:#dff6fb; font:600 13px var(--ui-mono); }
      .science-archive-metric em { color:#708995; font:6.5px var(--ui-mono); font-style:normal; text-align:right; }
      .science-filter-deck { flex:0 0 auto; padding:9px 12px 8px; border-bottom:1px solid #203744;
        background:linear-gradient(180deg,rgba(10,25,34,.98),rgba(7,18,25,.98)); }
      .science-search { display:grid; grid-template-columns:104px 1fr; align-items:center; gap:8px; }
      .science-search > span,.science-filter > span { color:#7f99a7; font:7px var(--ui-mono); letter-spacing:1.35px; }
      .science-search input,.science-filter select { min-width:0; border:1px solid #304b5d; border-radius:3px;
        background:#07151e; color:#d9e8ee; font:9px var(--ui-mono); outline:none; }
      .science-search input { height:29px; padding:0 9px; }
      .science-search input:focus,.science-filter select:focus { border-color:var(--ui-accent); box-shadow:0 0 0 1px rgba(82,172,208,.22); }
      .science-search input::placeholder { color:#57707e; }
      .science-filter-controls { display:grid; grid-template-columns:1fr 1fr 1.25fr 1fr auto; gap:6px; margin-top:7px; align-items:end; }
      .science-filter { display:flex; min-width:0; flex-direction:column; gap:3px; }
      .science-filter select { width:100%; height:27px; padding:0 5px; text-transform:capitalize; }
      .science-filter-clear { height:27px; padding:0 8px; border:1px solid #405764; border-radius:3px;
        background:#101d24; color:#a9bdc7; font:8px var(--ui-mono); cursor:pointer; white-space:nowrap; }
      .science-filter-clear:hover:not(:disabled) { border-color:var(--ui-accent); color:#fff; }
      .science-filter-clear:disabled { opacity:.38; cursor:not-allowed; }
      .science-filter-summary { flex:0 0 auto; display:flex; justify-content:space-between; gap:12px; padding:6px 13px;
        border-bottom:1px solid #1d303b; color:#7f97a4; font:7.5px var(--ui-mono); letter-spacing:.35px; }
      .science-filter-summary span:last-child { color:#6c8795; }
      .science-archive-scroll { flex:1 1 auto; min-height:0; overflow:auto; overscroll-behavior:contain;
        padding:10px 11px 16px; scrollbar-color:#38566a #0a1720; scrollbar-width:thin; }
      .science-section-heading { display:flex; align-items:end; justify-content:space-between; gap:10px; margin-bottom:7px; }
      .science-section-heading > div { display:flex; flex-direction:column; }
      .science-section-heading span { color:#d2a95a; font:7px var(--ui-mono); letter-spacing:1.6px; }
      .science-section-heading strong { color:#dbe7ec; font-size:10px; }
      .science-section-heading em { color:#e1ba6b; font:8px var(--ui-mono); font-style:normal; }
      .science-aboard-section { margin-bottom:10px; padding:9px; border:1px solid #5a4a2d;
        background:linear-gradient(120deg,rgba(58,43,18,.42),rgba(13,24,30,.74)); }
      .science-aboard-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
      .science-aboard-card { min-width:0; padding:7px 8px; border-left:3px solid #e1b45b; background:rgba(8,19,25,.84); }
      .science-aboard-card.recover-only { border-left-color:#d4825e; }
      .science-aboard-vessel { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        color:#8ca2ae; font:7px var(--ui-mono); letter-spacing:.85px; text-transform:uppercase; }
      .science-aboard-card strong { display:block; margin:2px 0; color:#eff4f5; font-size:9.5px; }
      .science-aboard-location { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#7d95a1; font-size:8px; }
      .science-aboard-value { margin-top:4px; color:#e2b967; font:7.5px var(--ui-mono); }
      .science-world-dossier { margin-bottom:7px; border:1px solid #294252; background:rgba(8,18,24,.74); }
      .science-world-dossier[open] { border-color:#3b5d70; }
      .science-world-summary { list-style:none; display:grid; grid-template-columns:1fr minmax(130px,.8fr) auto; gap:12px;
        align-items:center; padding:8px 10px; cursor:pointer; user-select:none;
        background:linear-gradient(90deg,rgba(23,48,61,.82),rgba(11,25,33,.9)); }
      .science-world-summary::-webkit-details-marker { display:none; }
      .science-world-summary::before { content:'›'; grid-column:3; grid-row:1; color:#7994a2; font:14px var(--ui-mono);
        transform:rotate(0deg); transition:transform .12s ease; justify-self:end; }
      .science-world-dossier[open] > .science-world-summary::before { transform:rotate(90deg); }
      .science-world-identity { display:flex; min-width:0; flex-direction:column; }
      .science-world-identity span { color:#66818f; font:6.5px var(--ui-mono); letter-spacing:1.6px; }
      .science-world-identity strong { color:#e3edf1; font-size:11px; }
      .science-world-progress { display:grid; grid-template-columns:auto 1fr; gap:6px; align-items:center; }
      .science-world-progress span { color:#849aa5; font:7px var(--ui-mono); white-space:nowrap; }
      .science-progress-rail { height:4px; min-width:45px; overflow:hidden; background:#0b1720; }
      .science-progress-rail > div { height:100%; background:linear-gradient(90deg,#397d95,#72b9c6); }
      .science-world-summary em { grid-column:3; grid-row:1; margin-right:18px; color:#718a96; font:7px var(--ui-mono); font-style:normal; }
      .science-site-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; padding:8px; border-top:1px solid #263e4c; }
      .science-site-card { min-width:0; border:1px solid #263d4a; border-top:2px solid #425765; background:#0a1720; }
      .science-site-card.in-progress { border-top-color:#d0a451; }
      .science-site-card.complete { border-top-color:#5eaa83; }
      .science-site-header { display:flex; justify-content:space-between; gap:8px; align-items:center; padding:6px 7px;
        border-bottom:1px solid #20343f; background:rgba(17,34,43,.82); }
      .science-site-header > div { min-width:0; display:flex; flex-direction:column; }
      .science-site-header span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        color:#667f8c; font:6.5px var(--ui-mono); letter-spacing:1px; }
      .science-site-header strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d7e2e7; font-size:9px; }
      .science-site-header em { flex:0 0 auto; padding:2px 4px; border:1px solid #344e5d; color:#8ba3af;
        font:6.5px var(--ui-mono); font-style:normal; text-transform:uppercase; }
      .science-record-list { padding:2px 7px 5px; }
      .science-record-row { display:grid; grid-template-columns:minmax(0,1fr) auto 38px; column-gap:7px; align-items:center;
        padding:5px 0; border-bottom:1px solid #172a34; }
      .science-record-row:last-child { border-bottom:0; }
      .science-record-copy { min-width:0; display:flex; flex-direction:column; }
      .science-record-copy strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cbd9df; font-size:8.5px; }
      .science-record-state { width:max-content; margin-top:1px; color:#687f8a; font:6px var(--ui-mono); text-transform:uppercase; }
      .science-record-state.in-progress { color:#d6aa5a; }
      .science-record-state.complete { color:#71ba93; }
      .science-record-channels { display:flex; gap:5px; color:#76909d; font:6.5px var(--ui-mono); }
      .science-record-remaining { color:#a9bec7; font:7px var(--ui-mono); text-align:right; }
      .science-record-rail { grid-column:1/-1; height:2px; margin-top:4px; overflow:hidden; background:#13232c; }
      .science-record-rail > div { height:100%; background:#568fa4; }
      .science-site-card.complete .science-record-rail > div { background:#61a982; }
      .science-empty-state { display:flex; min-height:150px; flex-direction:column; align-items:center; justify-content:center;
        padding:20px; text-align:center; border:1px dashed #304957; color:#718a97; }
      .science-empty-state strong { color:#c4d3da; font-size:11px; }
      .science-empty-state span { max-width:360px; margin-top:5px; font-size:8.5px; line-height:1.45; }
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
      /* Program Control: connected capability tree and operation views. */
      .program-command-header { flex:0 0 auto; display:grid; grid-template-columns:minmax(170px,.8fr) 2fr; gap:14px;
        align-items:center; padding:13px 15px 11px; border-bottom:1px solid #4a4932;
        background:linear-gradient(115deg,rgba(57,52,25,.78),rgba(17,29,34,.94) 58%,rgba(12,24,31,.9)); }
      .program-command-identity { min-width:0; display:flex; flex-direction:column; }
      .program-kicker { color:#ae9e68; font:7px var(--ui-mono); letter-spacing:1.8px; }
      .program-command-title { margin-top:3px; color:#f2eedf; font:600 16px var(--ui-font); letter-spacing:.4px; }
      .program-command-metrics { display:grid; grid-template-columns:repeat(4,minmax(72px,1fr)); gap:6px; }
      .program-command-metric { min-width:0; padding:6px 7px; border:1px solid #4d4a30;
        background:rgba(14,20,20,.68); display:grid; grid-template-columns:1fr auto; align-items:end; }
      .program-command-metric span { grid-column:1/-1; color:#918761; font:7px var(--ui-mono); letter-spacing:1.2px; }
      .program-command-metric strong { margin-top:2px; color:#f2d98d; font:600 13px var(--ui-mono); }
      .program-command-metric em { color:#766f55; font:6.5px var(--ui-mono); font-style:normal; text-align:right; }
      .program-tabs { flex:0 0 auto; display:flex; gap:0; padding:0 12px; border-bottom:1px solid #253943; background:#09161e; }
      .program-tab { position:relative; padding:9px 12px 8px; border:0; border-right:1px solid #223844;
        background:transparent; color:#7d929c; font:7.5px var(--ui-mono); letter-spacing:1px; text-transform:uppercase; cursor:pointer; }
      .program-tab:first-child { border-left:1px solid #223844; }
      .program-tab:hover { color:#dce8ec; background:rgba(31,55,65,.42); }
      .program-tab.active { color:#efd58c; background:rgba(67,61,31,.38); }
      .program-tab.active::after { content:''; position:absolute; left:9px; right:9px; bottom:-1px; height:2px; background:#d6b95f; }
      .program-view { flex:1 1 auto; min-height:0; overflow:auto; overscroll-behavior:contain;
        padding:11px 12px 16px; scrollbar-color:#4b5360 #0a1720; scrollbar-width:thin; }
      .tech-tree-intro { display:flex; justify-content:space-between; gap:12px; align-items:end; margin-bottom:9px; }
      .tech-tree-intro > div:first-child { display:flex; flex-direction:column; }
      .tech-tree-intro strong { color:#dfe7e8; font-size:10px; }
      .tech-tree-intro span { margin-top:2px; color:#738a95; font-size:8px; }
      .tech-tree-legend { display:flex; gap:4px; }
      .tech-tree-legend span { margin:0; padding:3px 5px; border:1px solid #344650; font:6.5px var(--ui-mono); text-transform:uppercase; }
      .tech-legend-deployed { color:#79bd94 !important; border-color:#3f7356 !important; }
      .tech-legend-available { color:#e1bd68 !important; border-color:#766434 !important; }
      .tech-legend-locked { color:#697985 !important; }
      .tech-tree-scroll { width:100%; overflow:auto; overscroll-behavior:contain; border:1px solid #293e49;
        background:#071119; scrollbar-color:#485b65 #0b1720; scrollbar-width:thin; }
      .tech-tree-scroll:focus { outline:1px solid #758260; outline-offset:2px; }
      .tech-tree-canvas { position:relative; width:1060px; height:470px;
        background-color:#08141b;
        background-image:linear-gradient(rgba(70,92,100,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(70,92,100,.07) 1px,transparent 1px);
        background-size:24px 24px; }
      .tech-tree-links { position:absolute; inset:0; width:1060px; height:470px; overflow:visible; }
      .tech-tree-links path { fill:none; stroke:#2b3c44; stroke-width:2; }
      .tech-tree-links path.available { stroke:#8b763c; stroke-dasharray:5 4; }
      .tech-tree-links path.deployed { stroke:#51896a; stroke-width:3; }
      .tech-node { position:absolute; box-sizing:border-box; width:172px; height:112px; padding:8px 9px;
        display:flex; flex-direction:column; border:1px solid #354752; border-top:3px solid #4a5d67;
        background:linear-gradient(145deg,rgba(19,34,41,.98),rgba(8,18,24,.98)); box-shadow:0 8px 18px rgba(0,0,0,.28); }
      .tech-node.available { border-color:#746435; border-top-color:#d4b257;
        background:linear-gradient(145deg,rgba(53,48,25,.96),rgba(13,24,27,.98)); }
      .tech-node.deployed { border-color:#3f7055; border-top-color:#69ae85;
        background:linear-gradient(145deg,rgba(24,53,43,.96),rgba(9,25,27,.98)); }
      .tech-node.locked { opacity:.68; filter:saturate(.5); }
      .tech-node-state { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#71838d;
        font:6px var(--ui-mono); letter-spacing:.9px; }
      .tech-node.available .tech-node-state { color:#d2ad58; }
      .tech-node.deployed .tech-node-state { color:#72b38c; }
      .tech-node-name { margin-top:4px; color:#e5ecee; font-size:10px; line-height:1.1; }
      .tech-node-meta { margin-top:4px; color:#80939c; font:6.5px var(--ui-mono); }
      .tech-node-action { margin-top:auto; height:24px; border:1px solid #8b7538; background:#302b15; color:#f0d787;
        font:7px var(--ui-mono); text-transform:uppercase; cursor:pointer; }
      .tech-node-action:hover:not(:disabled) { border-color:#e0bf63; background:#443b1b; color:#fff0b8; }
      .tech-node-action:disabled { border-color:#34434a; background:#142129; color:#647680; cursor:not-allowed; }
      .tech-node-deployed { margin-top:auto; padding-top:5px; border-top:1px solid #315641; color:#73b68d;
        font:6.5px var(--ui-mono); text-transform:uppercase; }
      .program-view-heading { display:flex; justify-content:space-between; gap:12px; align-items:end; margin-bottom:10px;
        padding-bottom:7px; border-bottom:1px solid #2a3e47; }
      .program-view-heading strong { color:#e3ebed; font-size:11px; }
      .program-view-heading span { color:#7e929b; font-size:8px; text-align:right; }
      .research-program-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
      .research-program-card { display:grid; grid-template-columns:72px 1fr; border:1px solid #625633; border-top:3px solid #d0ad51;
        background:linear-gradient(135deg,rgba(49,43,20,.72),rgba(10,23,28,.94)); }
      .research-program-card.locked { filter:saturate(.45); opacity:.7; }
      .research-level { display:flex; flex-direction:column; align-items:center; justify-content:center; border-right:1px solid #574c2c;
        background:rgba(19,26,23,.58); }
      .research-level span { color:#8f8155; font:6.5px var(--ui-mono); letter-spacing:1.4px; }
      .research-level strong { color:#f1d477; font:600 29px var(--ui-mono); line-height:1; }
      .research-copy { min-width:0; padding:10px 11px 7px; }
      .research-copy > strong { color:#f0eee4; font-size:11px; }
      .research-copy p { min-height:38px; margin:4px 0 7px; color:#8ea0a5; font-size:8.5px; line-height:1.45; }
      .research-effect { padding:5px 6px; border-left:2px solid #c8a547; background:rgba(15,28,31,.64);
        color:#d7bd70; font:7px var(--ui-mono); }
      .research-footer { grid-column:1/-1; display:flex; justify-content:space-between; gap:10px; align-items:center;
        padding:7px 9px; border-top:1px solid #4d452b; color:#aa9452; font:7px var(--ui-mono); }
      .research-buy { font-size:8px; }
      .contract-operation-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .contract-operation-card { position:relative; min-height:126px; padding:10px 10px 9px; border:1px solid #374c57;
        border-left:3px solid #70818a; background:linear-gradient(135deg,rgba(21,37,44,.94),rgba(8,18,24,.96)); }
      .contract-operation-card.active { border-left-color:#d3aa52; background:linear-gradient(135deg,rgba(48,43,22,.72),rgba(9,21,26,.96)); }
      .contract-operation-card.complete { border-left-color:#67aa83; background:linear-gradient(135deg,rgba(22,50,40,.74),rgba(8,22,25,.96)); }
      .contract-operation-card.locked { opacity:.62; }
      .contract-state { color:#899aa2; font:6.5px var(--ui-mono); letter-spacing:1px; }
      .contract-operation-card.active .contract-state { color:#d3aa52; }
      .contract-operation-card.complete .contract-state { color:#6db18a; }
      .contract-operation-card > strong { display:block; margin-top:4px; color:#e4ecee; font-size:11px; }
      .contract-operation-card p { min-height:30px; margin:4px 0 8px; color:#899ba3; font-size:8.5px; line-height:1.4; }
      .contract-reward { color:#d2b363; font:7.5px var(--ui-mono); }
      .contract-accept { position:absolute; right:9px; bottom:8px; font-size:8px; }
      .ed-campaign-balance { position:absolute; left:10px; top:calc(100% + 4px); color:#e3b75e;
        font:8px var(--ui-mono); letter-spacing:.8px; white-space:nowrap; padding:4px 7px;
        border:1px solid #4e4937; border-radius:3px; background:rgba(8,16,22,.92); }
      .ed-part-locked { opacity:.64; cursor:not-allowed; border-color:#2d3740; filter:saturate(.35); }
      .ed-part-locked:hover { border-color:#725f43; }
      .ed-part-tech { color:#dda94a; font:7.5px var(--ui-mono); letter-spacing:.65px; margin-top:2px; }
      .k-reduced-motion *, .k-reduced-motion *::before, .k-reduced-motion *::after {
        animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important;
      }

      @media (max-width:820px), (pointer:coarse) {
        .k-icon-btn { width:42px; height:42px; }
        .ed-root { height:100dvh; }
        .ed-right { position:static; display:contents; padding:0; border:0; background:transparent; overflow:visible; }
        .ed-mobile-panel { display:none !important; position:absolute; left:0; right:0; top:auto; bottom:calc(57px + env(safe-area-inset-bottom));
          width:100%; height:min(46dvh,440px); max-height:46dvh; padding:10px 10px 12px;
          border:1px solid #345267; border-width:1px 0 0; border-radius:14px 14px 0 0;
          background:linear-gradient(180deg,rgba(11,23,31,.98),rgba(6,12,18,.99));
          box-shadow:0 -18px 44px rgba(0,0,0,.46); overflow-y:auto; pointer-events:auto; z-index:52; }
        .ed-mobile-panel.mobile-open { display:flex !important; flex-direction:column; gap:8px; }
        .ed-left.mobile-open { display:flex !important; overflow:hidden; }
        .ed-title { padding:2px 4px 6px; }
        .ed-cats { flex-wrap:nowrap; overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:none;
          padding:2px 4px 5px; }
        .ed-cats::-webkit-scrollbar { display:none; }
        .ed-cats .ed-cat { flex:0 0 auto; }
        .ed-palette-tools { padding:0 4px 3px; }
        .ed-parts { min-height:0; flex:1; flex-direction:row; overflow-x:auto; overflow-y:hidden;
          scroll-snap-type:x mandatory; overscroll-behavior-x:contain; scrollbar-width:none; padding:3px 4px 6px; }
        .ed-parts::-webkit-scrollbar { display:none; }
        .ed-part { flex:0 0 min(82vw,320px); min-height:96px; scroll-snap-align:start;
          grid-template-columns:72px 1fr; -webkit-user-drag:none; }
        .ed-part-thumb { width:72px; height:72px; }
        .ed-topbar { position:absolute; top:max(6px,env(safe-area-inset-top)); left:6px; right:6px; width:auto;
          transform:none; display:grid; grid-template-columns:1fr; gap:4px; padding:5px; border-radius:7px; }
        .ed-topbar-primary { width:100%; }
        .ed-topbar-primary .ed-name { flex:1 1 auto; width:auto; min-width:0; }
        .ed-topbar-scroll { width:100%; overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:none;
          padding-top:4px; border-top:1px solid #233c4b; }
        .ed-topbar-scroll::-webkit-scrollbar { display:none; }
        .ed-topbar-scroll > * { flex:0 0 auto; min-height:44px; }
        .ed-topbar .ed-name { width:auto; }
        .ed-topbar .hud-btn { min-height:44px; padding:5px 10px; }
        .ed-launch { min-height:44px; white-space:nowrap; }
        .ed-mobile-multi { display:block; }
        .ed-mobile-dock { position:absolute; display:grid; grid-template-columns:repeat(4,1fr); left:0; right:0; bottom:0;
          min-height:calc(57px + env(safe-area-inset-bottom)); padding:5px 6px calc(5px + env(safe-area-inset-bottom));
          gap:4px; background:rgba(5,12,18,.98); border-top:1px solid #345267; pointer-events:auto; z-index:55; }
        .ed-mobile-dock-btn { min-width:0; min-height:44px; border:1px solid #263f50; border-radius:6px;
          background:#0d1a23; color:#9fb4c4; font:700 10px var(--ui-font); letter-spacing:.4px; }
        .ed-mobile-dock-btn.active { border-color:var(--ui-accent); background:#173344; color:#e7f7ff; }
        .ed-mobile-panel button,.ed-mobile-panel input,.ed-mobile-panel select,.ed-mobile-panel .ed-stage-part { min-height:44px; }
        .ed-part { min-height:72px; }
        .ed-part-context.touch-sheet { position:absolute; left:0 !important; right:0; top:auto !important;
          bottom:calc(57px + env(safe-area-inset-bottom)); width:100%; max-height:46dvh; overflow-y:auto;
          border-width:1px 0 0; border-radius:14px 14px 0 0; padding:14px 12px; }
        .ed-part-context.touch-sheet button,.ed-part-context.touch-sheet select { min-height:44px; }
        .ed-hint { display:none; }
        .ed-notice { top:calc(110px + env(safe-area-inset-top)); }
        .ed-utility-host { bottom:calc(61px + env(safe-area-inset-bottom)); }
        .ed-utility-host .k-launcher,.hud-utility-host .k-launcher { gap:2px; }
        .map-panel { position:fixed; left:0 !important; right:0; top:auto !important; bottom:0;
          width:auto !important; height:auto !important; max-width:none; max-height:min(45dvh,390px);
          border-width:1px 0 0; border-radius:12px 12px 0 0; }
        .map-panel-bar { min-height:40px; cursor:default; touch-action:auto; }
        .map-panel-content { padding:10px 12px calc(10px + env(safe-area-inset-bottom)); overflow-y:auto; }
        .map-panel:not(.has-node) { right:auto !important; width:min(280px,calc(100vw - 24px)) !important;
          border-right-width: 1px; border-radius: 0 12px 0 0; }
        .map-axis { grid-template-columns:96px 42px minmax(80px,1fr) 42px; }
        .map-axis label { width:auto; }
        .map-axis input[type=range] { order: 5; flex-basis: 100%; height: 26px; }
        .map-axis button { width: 42px; min-height: 42px; }
        .map-number { flex: 1; min-height: 34px; font-size: 13px; }
        .map-step-row button, .map-snap-row button { min-height: 38px; padding-inline: 10px; }
        .map-node-actions .hud-btn { min-height:42px; }
        .map-node-actions .map-action-primary { flex-basis:calc(100% - 96px); }
        .map-node-actions .map-action-warp,.map-node-actions .map-action-auto { flex-basis:calc(50% - 3px); }
        .map-camera-controls { right:6px; top:92px; }
        .map-camera-btn { width:38px; height:38px; }
        .map-camera-hint { display:none; }
        .k-window[data-window-id="transfers"] { width:auto; max-width:none; }
        .transfer-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
      }

      /* Touch flight deck: preserve the view while keeping primary controls thumb-reachable. */
      @media (max-width:820px), (pointer:coarse) {
        #perf-mini { display:none !important; }
        .hud { --hud-mobile-top: max(6px, env(safe-area-inset-top)); }
        .hud-top { top:var(--hud-mobile-top); left:6px; right:6px; width:auto; transform:none;
          display:grid; gap:4px; padding:4px 5px;
          border-color:#365264; background:linear-gradient(180deg,rgba(9,20,28,.97),rgba(6,13,19,.94));
          box-shadow:0 8px 24px rgba(0,0,0,.28); }
        .hud-meta { grid-template-columns:auto minmax(66px,1fr) minmax(120px,1.35fr) auto; gap:6px; }
        .hud-crew,.hud-next-alarm,.hud-comms,.hud-vessel-label { display:none; }
        .hud-met { min-width:0; padding-right:6px; font-size:11px; white-space:nowrap; }
        .hud-situation { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          text-align:left; font-size:10px; letter-spacing:1.4px; }
        .hud-vessel-control { grid-template-columns:minmax(0,1fr); padding-left:5px; }
        .hud-vessel-select { height:32px; font-size:9px; }
        .hud-warp-group { gap:3px; }
        .hud-warp { min-width:0; font-size:11px; white-space:nowrap; }
        .hud-warp-btns { gap:3px; }
        .hud-warp-btns .hud-btn { width:34px; min-height:32px; padding:0; font-size:10px; }

        .hud-sys { position:static; display:flex; justify-content:flex-start; gap:4px; padding:4px 0 0;
          overflow-x:auto; overscroll-behavior-x:contain; scrollbar-width:none; border-top-color:#294351; }
        .hud-sys::-webkit-scrollbar { display:none; }
        .hud-sys .hud-btn { flex:0 0 auto; min-height:36px; padding:4px 11px; font-size:10px; white-space:nowrap; }
        .hud-main { min-width:0; }
        .hud-recover { margin-left:0; }
        .hud-orbit-strip { gap:3px; }
        .hud-apsis-indicator { width:74px; min-height:36px; grid-template-columns:15px minmax(0,1fr);
          grid-template-rows:1fr; grid-template-areas:'label value'; gap:3px; padding:4px 5px; }
        .hud-apsis-label { font-size:8px; }
        .hud-apsis-value { font-size:7.5px; text-overflow:clip; }
        .hud-apsis-eta { display:none; }
        .hud-resource-strip { gap:3px; margin-right:1px; }
        .hud-resource-indicator { width:50px; min-height:36px; grid-template-columns:16px minmax(18px,1fr);
          gap:4px; padding:4px 5px; }
        .hud-resource-value { display:none; }

        .hud-right { top:calc(var(--hud-mobile-top) + 98px); left:6px; right:6px; width:auto;
          display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:6px; }
        .hud-data-toggle { grid-column:1/-1; min-height:32px; }
        .hud-panel { padding:6px 8px; border-radius:6px; background:rgba(7,16,23,.91); }
        .hud-node-panel,.hud-resources { min-width:0; }
        .hud-status-strip,.hud-node-panel,.hud-staging,.hud-entry-card,.hud-systems,.hud-science-status { grid-column:1/-1; }
        .hud-row { gap:5px; font-size:11px; }
        .hud-key { min-width:28px; font-size:9px; }
        .hud-eta { font-size:9px; white-space:nowrap; }
        .hud-node-info { font-size:9px; }
        .hud-gauge { gap:4px; padding:1px 0; }
        .hud-gauge-track { min-width:22px; height:6px; }
        .hud-gauge-text { min-width:28px; font-size:9px; }
        .hud-stages { width:min(200px,100%); justify-self:end; max-height:none; }
        .hud-stage-btn { min-height:44px; margin:0; font-size:11px; letter-spacing:.7px; }
        .hud-stage-list { display:none; }

        .hud-left { bottom:calc(88px + env(safe-area-inset-bottom)); }
        .hud-navwrap { transform:scale(.78); transform-origin:50% 100%; }
        .hud-nav-data { left:50%; right:auto; top:-53px; width:210px; transform:translateX(-50%);
          flex-direction:row; gap:3px; }
        .hud-nav-datum { flex:1; min-width:0; padding:4px 5px; border-radius:4px; text-align:center; }
        .hud-sas { left:50%; top:-100px; width:214px; padding:6px;
          grid-template-columns:repeat(4,1fr); gap:4px; transform:translateX(-50%); border-radius:7px; }
        .hud-sas-btn { width:auto; height:38px; }
        .hud-events { top:calc(var(--hud-mobile-top) + 196px); left:8px; right:8px; max-width:none; gap:3px; }
        .hud-event { width:fit-content; max-width:100%; padding:4px 8px; font-size:10px; }
        .hud-companion { position:absolute; left:7px; bottom:calc(61px + env(safe-area-inset-bottom));
          max-width:calc(100vw - 14px); gap:0; }
        .hud-companion-avatar { width:48px; height:53px; flex-basis:48px; border-radius:13px 13px 8px 8px; }
        .hud-companion-mark { width:38px; height:38px; }
        .hud-companion-nameplate { font-size:6px; }
        .hud-companion-bubble { position:absolute; left:0; bottom:59px; width:min(294px,calc(100vw - 14px));
          min-width:0; max-width:none; border-radius:10px 10px 10px 3px; }
        .hud-companion-bubble::before { left:17px; bottom:-7px; transform:rotate(-45deg); }
        .hud-companion-copy { padding:8px 10px 10px; }
        .hud-companion-message { font-size:10px; }
        .hud-companion-action { font-size:8.5px; }
        .hud-part-popup { left:8px !important; right:8px; width:auto; max-height:48dvh; overflow-y:auto; }

        .hud-touch-controls { position:absolute; z-index:10; right:7px;
          bottom:calc(64px + env(safe-area-inset-bottom)); width:94px; display:grid;
          grid-template-columns:repeat(3,1fr); grid-template-rows:28px repeat(2,34px) 30px; gap:3px;
          padding:5px; border:1px solid #365365; border-radius:9px; background:rgba(6,14,20,.88);
          pointer-events:auto; box-shadow:0 8px 22px rgba(0,0,0,.34); }
        .hud-touch-controls button { min-width:0; min-height:0; padding:0; border:1px solid #365365;
          border-radius:5px; background:#0b1922; color:#a9bec9; font:700 13px var(--ui-mono); touch-action:none; }
        .hud-touch-controls button.active { border-color:var(--ui-accent); background:#1a4053; color:#fff; }
        .hud-touch-mode { grid-column:1/-1; font-size:8px !important; letter-spacing:1px; }
        .hud-touch-btn.up { grid-column:2; grid-row:2; }
        .hud-touch-btn.left { grid-column:1; grid-row:3; }
        .hud-touch-btn.down { grid-column:2; grid-row:3; }
        .hud-touch-btn.right { grid-column:3; grid-row:3; }
        .hud-touch-btn.roll-left { grid-column:1; grid-row:4; }
        .hud-touch-btn.roll-right { grid-column:3; grid-row:4; }

        .hud-utility-host { left:0; right:0; bottom:0; padding:5px 6px calc(5px + env(safe-area-inset-bottom));
          overflow:hidden; background:linear-gradient(180deg,rgba(7,16,23,.98),rgba(4,10,15,.99));
          border-top:1px solid #345267; box-shadow:0 -10px 28px rgba(0,0,0,.34); }
        .hud-utility-host .k-launcher { flex-direction:row; flex-wrap:nowrap; gap:4px; overflow-x:auto;
          overscroll-behavior-x:contain; scrollbar-width:none; }
        .hud-utility-host .k-launcher::-webkit-scrollbar { display:none; }
        .hud-utility-host .k-icon-btn { flex:0 0 42px; border:1px solid #2f4859; border-radius:5px; }
        .hud-utility-host .k-icon-tooltip { left:50%; top:auto; bottom:calc(100% + 7px);
          transform:translate(-50%,4px); }
        .hud-utility-host .k-icon-btn:hover .k-icon-tooltip,
        .hud-utility-host .k-icon-btn:focus-visible .k-icon-tooltip { transform:translate(-50%,0); }

        .k-window { position:fixed; left:6px !important; right:6px; top:auto !important;
          bottom:calc(58px + env(safe-area-inset-bottom)); width:auto !important; height:auto !important; min-width:0; max-width:none;
          max-height:min(58dvh,520px); overflow:hidden; border-radius:10px 10px 5px 5px;
          box-shadow:0 -14px 42px rgba(0,0,0,.46); }
        .k-window-resize-handle { display:none; }
        .k-window-bar { min-height:40px; cursor:default; }
        .k-window-content { max-height:calc(min(58dvh,520px) - 40px); overflow-y:auto; }
        .science-archive,.program-console { height:calc(min(58dvh,520px) - 40px); min-height:0; max-height:none; overflow:hidden; }
        .science-archive-header,.program-command-header { grid-template-columns:1fr; gap:8px; padding:9px 10px; }
        .science-archive-title,.program-command-identity { display:none; }
        .science-archive-metrics,.program-command-metrics { grid-template-columns:repeat(4,minmax(0,1fr)); }
        .science-archive-metric,.program-command-metric { padding:5px; }
        .science-filter-deck { padding:7px 8px; }
        .science-search { grid-template-columns:1fr; gap:3px; }
        .science-filter-controls { grid-template-columns:1fr 1fr; }
        .science-filter-clear { width:100%; }
        .science-filter-summary span:last-child { display:none; }
        .science-aboard-grid,.science-site-grid,.research-program-grid,.contract-operation-grid { grid-template-columns:1fr; }
        .science-world-summary { grid-template-columns:1fr auto; }
        .science-world-progress { display:none; }
        .science-world-summary em { grid-column:2; }
        .program-tabs { overflow-x:auto; padding:0 6px; }
        .program-tab { flex:0 0 auto; min-height:38px; }
        .program-view { padding:8px; }
        .tech-tree-intro { align-items:flex-start; }
        .tech-tree-legend { display:none; }
        .research-program-card { grid-template-columns:58px 1fr; }
        .map-panel { bottom:calc(58px + env(safe-area-inset-bottom)) !important; }
      }

      @media (max-width:340px) {
        .hud-navwrap { transform:scale(.7); }
        .hud-right { grid-template-columns:1fr; }
        .hud-data-toggle,.hud-status-strip,.hud-node-panel,.hud-resources,.hud-staging,.hud-entry-card,.hud-systems { grid-column:1; }
        .hud-touch-controls { width:86px; }
        .hud-events { top:calc(var(--hud-mobile-top) + 224px); }
        .hud-companion-bubble { width:calc(100vw - 14px); }
      }

      @media (max-height:500px) and (min-width:600px) {
        .ed-left.mobile-open { height:52dvh; max-height:52dvh; padding:6px; gap:4px; }
        .ed-left.mobile-open .ed-title { display:none; }
        .ed-left.mobile-open .ed-cats { padding:0 0 3px; }
        .ed-left.mobile-open .ed-palette-tools { padding:0 0 3px; }
        .ed-left.mobile-open .ed-part { min-height:76px; grid-template-columns:64px 1fr; }
        .ed-left.mobile-open .ed-part-thumb { width:64px; height:64px; }
        .ed-utility-host { left:0; right:0; bottom:calc(61px + env(safe-area-inset-bottom));
          padding:3px 6px; background:linear-gradient(180deg,rgba(7,16,23,.92),rgba(4,10,15,.98)); }
        .ed-utility-host .k-launcher { flex-direction:row; flex-wrap:nowrap; overflow-x:auto; }
        .ed-utility-host .k-icon-btn { flex:0 0 40px; border:1px solid #2f4859; border-radius:5px; }
        .hud-top { right:226px; width:auto; }
        .hud-right { top:var(--hud-mobile-top); left:auto; right:6px; width:214px;
          grid-template-columns:1fr; }
        .hud-data-toggle,.hud-status-strip,.hud-node-panel,.hud-resources,.hud-staging,
        .hud-entry-card,.hud-systems,.hud-science-status { grid-column:1; }
        .hud-left { bottom:calc(62px + env(safe-area-inset-bottom)); }
        .hud-navwrap { transform:scale(.62); }
        .hud-touch-controls { right:224px; bottom:calc(60px + env(safe-area-inset-bottom));
          transform:scale(.84); transform-origin:100% 100%; }
        .hud-events { top:calc(var(--hud-mobile-top) + 94px); right:232px; }
        .hud-companion { bottom:calc(58px + env(safe-area-inset-bottom)); }
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
        grid-template-columns:repeat(var(--mission-count,4),minmax(128px,1fr)) auto; gap:8px;
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
      .perilune-mission-qualifier { display:block; margin-top:7px; color:#caa75d; font:6.5px/1.35 var(--ui-mono);
        letter-spacing:.55px; }
      .perilune-menu-utilities { grid-column:-2/-1; display:flex; align-items:center; gap:6px; padding:0 4px 0 10px; border-left:1px solid #29404f; }
      .perilune-menu-utilities .k-icon-btn { width:42px; height:42px; }
      @keyframes menuDeckIn { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
      @media (max-width:1100px) and (min-width:821px) {
        .perilune-command-deck-artemis { grid-template-columns:repeat(3,minmax(0,1fr)); }
      }
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
      .tut-box { position:absolute; left:260px; top:56px; width:336px;
        background:linear-gradient(155deg,rgba(15,29,38,.98),rgba(7,15,22,.98)); border:1px solid #4a7185;
        border-top-color:#73b2ce; border-radius:8px; padding:11px 14px 12px; pointer-events:auto; z-index:40;
        box-shadow:0 18px 46px rgba(0,0,0,.46),inset 0 1px rgba(190,226,240,.05); }
      .tut-box.tut-map-visible:not(.dragging) { position:fixed; left:auto; right:14px; top:158px; }
      .tut-box.dragging { user-select:none; box-shadow:0 18px 42px rgba(0,0,0,.48); }
      .tut-header { display:flex; align-items:center; justify-content:space-between; gap:10px;
        min-height:28px; padding-bottom:6px; cursor:grab; touch-action:none; outline:none; }
      .tut-header:focus-visible { box-shadow:inset 0 0 0 1px var(--ui-accent); border-radius:4px; }
      .tut-box.dragging .tut-header { cursor:grabbing; }
      .tut-header-copy { min-width:0; }
      .tut-chapter { overflow:hidden; color:#9ab4c1; font:700 7.5px var(--ui-mono); letter-spacing:1.7px;
        text-overflow:ellipsis; white-space:nowrap; }
      .tut-progress { margin-top:2px; color:#73bfdc; font:8px var(--ui-mono); letter-spacing:1px; }
      .tut-move-hint { color:#718995; font:8px var(--ui-mono); letter-spacing:1.2px; }
      .tut-progress-rail { display:flex; gap:3px; height:3px; margin:0 0 12px; }
      .tut-progress-segment { flex:1; min-width:3px; border-radius:2px; background:#263b47; }
      .tut-progress-segment.is-complete { background:#6595aa; }
      .tut-progress-segment.is-current { background:#e2b13c; box-shadow:0 0 8px rgba(226,177,60,.32); }
      .tut-step-heading { display:flex; align-items:flex-start; gap:8px; }
      .tut-step-kind { flex:0 0 auto; margin-top:2px; padding:3px 5px; border:1px solid #466a7b; border-radius:3px;
        color:#9cc7d8; font:700 7px var(--ui-mono); letter-spacing:1px; }
      .tut-box[data-step-kind="watch"] .tut-step-kind { border-color:#6c648c; color:#bbb0df; }
      .tut-box[data-step-kind="read"] .tut-step-kind { border-color:#746744; color:#d7c27a; }
      .tut-box[data-step-kind="complete"] .tut-step-kind { border-color:#46765e; color:#8ed0ad; }
      .tut-title { flex:1; font-size:15px; line-height:1.25; margin:0 0 7px; color:#f2f7f9; font-weight:500; }
      .tut-text { font-size:11.5px; line-height:1.5; color:#b9c9d0; }
      .tut-next { margin-top:10px; padding:8px 9px; border-left:2px solid #dda94a; background:rgba(132,95,29,.13); }
      .tut-next-label { color:#dcb45d; font:700 7px var(--ui-mono); letter-spacing:1.4px; }
      .tut-next-text { margin-top:3px; color:#e8eef0; font-size:10.5px; line-height:1.4; }
      .tut-confirmation { margin-top:9px; padding:7px 9px; border:1px solid #48765f; border-radius:4px;
        background:rgba(36,91,65,.2); color:#9cd6b7; font:700 8px var(--ui-mono); letter-spacing:1.3px; }
      .tut-actions { display:flex; flex-direction:column; gap:7px; margin-top:11px; }
      .tut-primary-actions,.tut-secondary-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:5px; }
      .tut-actions .hud-btn { min-height:30px; }
      .tut-primary-action { min-width:126px; border-color:#5fa8c6; background:#153342; color:#e8f8ff; }
      .tut-secondary-action { border-color:#2d4654; background:#0b1921; color:#91a6b0; }
      .tut-step-complete { border-color:#53836b; }
      .tut-step-complete .tut-next { border-left-color:#57916f; background:rgba(47,106,75,.12); }
      .tut-actions [hidden] { display:none !important; }
      .tut-actions .tut-continue { border-color:#77bdd8; background:#17394a; color:#effbff; }
      .tut-actions .tut-second-light { border-color:#9784c7; color:#f3efff; }

      /* Artemis IV opens in a mission-safe lane and can be moved by its header. */
      .artiv-guide { position:fixed; left:auto; right:14px; top:150px;
        width:clamp(320px,28vw,356px); max-height:calc(100dvh - 164px); box-sizing:border-box;
        overflow-y:auto; padding:11px 14px 12px; pointer-events:auto; z-index:40;
        background:linear-gradient(155deg,rgba(15,29,38,.98),rgba(7,15,22,.98)); border:1px solid #4a7185;
        border-top-color:#73b2ce; border-radius:8px; box-shadow:0 18px 46px rgba(0,0,0,.46),inset 0 1px rgba(190,226,240,.05);
        scrollbar-width:thin; scrollbar-color:#365364 transparent; }
      .artiv-guide[hidden] { display:none; }
      .artiv-guide.dragging { user-select:none; box-shadow:0 18px 42px rgba(0,0,0,.52); }
      .artiv-guide-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
        min-height:31px; padding-bottom:7px; cursor:grab; touch-action:none; outline:none; }
      .artiv-guide-header:focus-visible { box-shadow:inset 0 0 0 1px var(--ui-accent); border-radius:4px; }
      .artiv-guide.dragging .artiv-guide-header { cursor:grabbing; }
      .artiv-guide-header-copy { min-width:0; }
      .artiv-guide-mission { color:#a7dced; font:700 8px var(--ui-mono); letter-spacing:2.1px; }
      .artiv-guide-progress { margin-top:3px; color:#70a9c0; font:7.5px var(--ui-mono); letter-spacing:1px; }
      .artiv-guide-mode { flex:0 0 auto; padding:3px 5px; border:1px solid #34576a; border-radius:3px;
        color:#7695a5; font:700 6.5px var(--ui-mono); letter-spacing:1px; }
      .artiv-guide-accuracy { margin:0 0 9px; padding:6px 8px; border:1px solid #5e5132;
        background:rgba(101,74,24,.12); color:#c9ad6a; font:7px/1.45 var(--ui-mono); letter-spacing:.6px; }
      .artiv-guide-rail { display:flex; gap:3px; height:3px; margin:0 0 9px; }
      .artiv-guide-progress-segment { flex:1; min-width:3px; border-radius:2px; background:#263b47; }
      .artiv-guide-progress-segment.is-complete { background:#6595aa; }
      .artiv-guide-progress-segment.is-current { background:#e2b13c; box-shadow:0 0 8px rgba(226,177,60,.32); }
      .artiv-guide-chapter-title { margin:0 0 9px; color:#839da9; font:700 8px/1.35 var(--ui-mono);
        letter-spacing:1.2px; text-transform:uppercase; }
      .artiv-guide-step-heading { display:flex; align-items:flex-start; gap:8px; }
      .artiv-guide-step-kind { flex:0 0 auto; margin-top:2px; padding:3px 5px; border:1px solid #466a7b;
        border-radius:3px; color:#9cc7d8; font:700 7px var(--ui-mono); letter-spacing:1px; }
      .artiv-guide[data-step-kind="watch"] .artiv-guide-step-kind { border-color:#6c648c; color:#bbb0df; }
      .artiv-guide[data-step-kind="read"] .artiv-guide-step-kind { border-color:#746744; color:#d7c27a; }
      .artiv-guide[data-step-kind="complete"] .artiv-guide-step-kind { border-color:#46765e; color:#8ed0ad; }
      .artiv-guide-title { flex:1; font-size:15px; line-height:1.25; margin:0 0 7px; color:#f2f7f9;
        font-weight:500; }
      .artiv-guide-next { margin-top:10px; padding:8px 9px; border-left:2px solid #dda94a;
        background:rgba(132,95,29,.13); }
      .artiv-guide-next-label { color:#dcb45d; font:700 7px var(--ui-mono); letter-spacing:1.4px; }
      .artiv-guide-next-text { margin-top:3px; color:#e8eef0; font-size:10.5px; line-height:1.4; }
      .artiv-guide-readouts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px;
        margin:8px 0 0; padding:0; }
      .artiv-guide-readouts[hidden] { display:none; }
      .artiv-guide-readout { min-width:0; padding:6px 7px; border:1px solid #294654; border-radius:4px;
        background:rgba(6,18,25,.72); }
      .artiv-guide-readout dt { overflow:hidden; margin:0; color:#78919d; font:6.5px var(--ui-mono);
        letter-spacing:1px; text-overflow:ellipsis; white-space:nowrap; text-transform:uppercase; }
      .artiv-guide-readout dd { overflow:hidden; margin:3px 0 0; color:#dce8ec; font:700 10px var(--ui-mono);
        text-overflow:ellipsis; white-space:nowrap; }
      .artiv-guide-readout[data-tone="good"] dd { color:#91cfaf; }
      .artiv-guide-readout[data-tone="caution"] dd { color:#e1bb68; }
      .artiv-guide-confirmation { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
        margin-top:9px; padding:7px 9px; border:1px solid #48765f; border-radius:4px;
        background:rgba(36,91,65,.2); color:#9cd6b7; font:700 8px var(--ui-mono); letter-spacing:1.3px; }
      .artiv-guide-confirmation[hidden] { display:none; }
      .artiv-guide-confirmation-label { flex:0 0 auto; }
      .artiv-guide-confirmation-message { color:#c7e6d5; font-weight:500; letter-spacing:.55px; text-align:right; }
      .artiv-guide-actions { display:flex; flex-direction:column; gap:7px; margin-top:11px; }
      .artiv-guide-primary-actions,.artiv-guide-secondary-actions { display:flex; justify-content:flex-end;
        flex-wrap:wrap; gap:5px; }
      .artiv-guide-actions .hud-btn { min-height:30px; }
      .artiv-guide-actions [hidden] { display:none !important; }
      .artiv-guide-primary { width:100%; min-height:36px; min-width:126px; border-color:#5fa8c6;
        background:#153342; color:#e8f8ff; }
      .artiv-guide-secondary-actions { justify-content:space-between; }
      .artiv-guide-secondary-action { border-color:#2d4654; color:#7f969f; background:rgba(6,16,22,.55); }
      .artiv-guide-step-complete { border-color:#53836b; }
      .artiv-guide-step-complete .artiv-guide-next { border-left-color:#57916f;
        background:rgba(47,106,75,.12); }
      @media (min-width:1100px) {
        .artiv-guide { right:244px; }
      }
      @media (max-width:700px) {
        .tut-box { position:fixed; left:8px; right:8px; top:calc(8px + env(safe-area-inset-top));
          width:auto; max-height:min(58dvh,470px); overflow-y:auto; padding:10px 12px; border-radius:8px; }
        .tut-box.tut-map-visible:not(.dragging) { left:8px; right:8px; top:calc(8px + env(safe-area-inset-top)); }
        .tut-title { font-size:14px; }
        .tut-text { font-size:11.5px; line-height:1.4; }
        .tut-secondary-actions { justify-content:flex-start; }
        .tut-actions .hud-btn { min-height:40px; }
        .tut-primary-action { width:100%; }
        .artiv-guide { left:8px; right:8px; top:calc(8px + env(safe-area-inset-top));
          width:auto; max-height:min(54dvh,450px); padding:10px 12px; border-radius:8px; }
        .artiv-guide-title { font-size:14px; }
        .artiv-guide-secondary-actions { justify-content:flex-start; }
        .artiv-guide-actions .hud-btn { min-height:40px; }
        .artiv-guide-primary { width:100%; }
      }
      @media (pointer:coarse) {
        .artiv-guide .hud-btn { min-height:42px; }
      }
  `;
  document.head.appendChild(style);
}
