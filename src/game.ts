/**
 * Perilune game shell: main menu → workshop (editor) → flight, the master
 * loop, input handling, and mission actions (staging, science, recovery,
 * quicksave/load, maneuver execution, time warp).
 */
import * as THREE from 'three';
import { Vec3 } from './core/vec3';
import { GameState, PHYSICS_WARP_RATES, RAILS_WARP_RATES } from './sim/state';
import { Craft, defOf } from './sim/vessel';
import { createRenderContext, RenderContext } from './render/context';
import { WorldScene } from './render/worldScene';
import { Editor } from './ui/editor';
import { FlightHud } from './ui/flightHud';
import { MapView } from './ui/mapView';
import { Tutorial } from './ui/tutorial';
import { PerfOverlay } from './ui/perfOverlay';
import { readSave, restoreGame, serializeGame, writeSave } from './save/persistence';
import {
  experimentKey,
  experimentValue,
  EXPERIMENT_INDEX,
  scienceSituation,
} from './content/science';
import { logEvent } from './sim/flight';
import { CommsStatus, evaluateComms, needsCommsForControl } from './sim/comms';
import { nodeBurnDirection, nodeDeltaV } from './sim/maneuver';
import { stateToElements } from './core/orbit';

type Screen = 'menu' | 'editor' | 'flight';

class PeriluneGame {
  private ctx!: RenderContext;
  private game = new GameState();
  private world!: WorldScene;
  private editor!: Editor;
  private hud!: FlightHud;
  private map!: MapView;
  private tutorial!: Tutorial;
  private perf!: PerfOverlay;
  private screen: Screen = 'menu';
  private menuEl!: HTMLElement;
  private uiRoot!: HTMLElement;
  private keys = new Set<string>();
  private dragging = false;
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  private lastFrame = performance.now();
  private launchedCraft: Craft | null = null;
  private missionStart = 0;
  private nodeRemainingDv = 0;
  private lastAutosave = 0;
  private comms: CommsStatus = { connected: true, path: [], strength: 1 };
  private lastCommsCheck = 0;
  private controlBlocked = false;
  private nodeBurnDir = new Vec3(1, 0, 0);
  private dialogEl: HTMLElement | null = null;

  async start(): Promise<void> {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.uiRoot = document.getElementById('ui-root') as HTMLElement;
    this.ctx = await createRenderContext(canvas);
    this.world = new WorldScene();
    this.perf = new PerfOverlay(this.uiRoot);
    this.editor = new Editor(this.uiRoot, {
      onLaunch: (craft) => this.launch(craft),
      onExit: () => this.showMenu(),
    });
    this.hud = new FlightHud(this.uiRoot, {
      onStage: () => this.stage(),
      onToggleMap: () => this.toggleMap(),
      onQuickSave: () => this.quickSave(),
      onQuickLoad: () => void this.quickLoad(),
      onRevert: () => this.revert(),
      onRunScience: () => this.runScience(),
      onRecover: () => this.recover(),
      onSetSas: (m) => {
        const gv = this.game.active;
        if (gv) gv.runtime.sas = m;
      },
      onSetWarp: (i, rails) => this.game.setWarp(i, rails),
      onExitToEditor: () => this.toEditor(),
    });
    this.hud.root.style.display = 'none';
    this.map = new MapView(this.uiRoot, {
      onWarpToNode: (t) => this.warpToNode(t),
    });
    this.tutorial = new Tutorial(this.uiRoot);
    this.buildMenu();
    this.bindInput(canvas);
    document.getElementById('boot')?.remove();
    requestAnimationFrame(() => this.frame());
    // Expose for the e2e harness: read-only state probes + a screen-space
    // projection helper so tests can aim real mouse clicks at 3D nodes.
    // All ACTIONS in tests go through real UI events.
    (window as unknown as Record<string, unknown>).__TEST__ = {
      screen: () => this.screen,
      partCount: () => this.editor.craft.parts.length,
      stageCount: () => this.editor.craft.stages.length,
      parts: () => this.editor.craft.parts.map((p) => ({ defId: p.defId, y: p.position.y })),
      projectEditor: (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(this.editor.camera);
        return {
          x: ((v.x + 1) / 2) * window.innerWidth,
          y: ((1 - v.y) / 2) * window.innerHeight,
        };
      },
      stackSpots: () =>
        this.editor.freeStackSpots().map((s) => ({
          kind: s.kind,
          x: s.pos.x,
          y: s.pos.y,
          z: s.pos.z,
        })),
      altitude: () => {
        const gv = this.game.active;
        if (!gv) return null;
        return gv.runtime.pos.length() - this.game.bodyOf(gv).radius;
      },
      situation: () => this.game.active?.runtime.situation ?? null,
      speed: () => this.game.active?.runtime.vel.length() ?? 0,
      throttle: () => this.game.active?.runtime.controls.throttle ?? 0,
      vesselCount: () => this.game.vessels.length,
      time: () => this.game.time,
      sciencePoints: () => this.game.sciencePoints,
      warpRate: () => this.game.warpRate,
      fuel: () => {
        const gv = this.game.active;
        if (!gv) return 0;
        return gv.runtime.craft.parts.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);
      },
      debug: () => ({
        holding:
          (this.editor as unknown as { holdingDef?: { id: string } }).holdingDef?.id ?? null,
        candidate:
          (this.editor as unknown as { candidate?: { kind: string } }).candidate?.kind ?? null,
      }),
    };
  }

  // ------------------------------------------------------------------ menu
  private buildMenu(): void {
    this.menuEl = document.createElement('div');
    this.menuEl.style.cssText = `
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 14px;
      background: radial-gradient(ellipse at 50% 65%, #0a1826 0%, #04070a 75%);
      pointer-events: auto; z-index: 60;
    `;
    this.menuEl.innerHTML = `
      <div style="font-size:54px;letter-spacing:16px;color:#6db3d6;font-weight:300">PERILUNE</div>
      <div style="font-size:12px;letter-spacing:3px;color:#7d8b96;margin-bottom:20px">A SPACE PROGRAM OF THE SKYWARD COOPERATIVE</div>
    `;
    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = label;
      b.style.cssText = 'width:260px;padding:10px;font-size:15px;';
      b.onclick = fn;
      this.menuEl.appendChild(b);
      return b;
    };
    mkBtn('Begin — First Light (tutorial)', () => {
      this.newGame();
      this.tutorial.start();
      this.toEditor();
    });
    mkBtn('Sandbox — just build and fly', () => {
      this.newGame();
      this.toEditor();
    });
    const cont = mkBtn('Continue from last save', async () => {
      const save = await readSave('auto');
      if (save) {
        this.game = restoreGame(save);
        if (this.game.active) this.toFlight(false);
        else this.toEditor();
      }
    });
    readSave('auto').then((s) => {
      if (!s) cont.style.opacity = '0.4';
    });
    this.uiRoot.appendChild(this.menuEl);
  }

  private newGame(): void {
    this.game = new GameState();
  }

  private showMenu(): void {
    this.screen = 'menu';
    this.menuEl.style.display = 'flex';
    this.editor.setVisible(false);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
  }

  private toEditor(): void {
    this.screen = 'editor';
    this.menuEl.style.display = 'none';
    this.editor.setVisible(true);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    void writeSave(this.game, 'auto', 'autosave');
  }

  private toFlight(spawn = true): void {
    this.screen = 'flight';
    this.menuEl.style.display = 'none';
    this.editor.setVisible(false);
    this.hud.root.style.display = '';
    this.map.setVisible(false);
    this.map.visible = false;
    this.missionStart = this.game.time;
    this.hud.setMissionStart(this.missionStart);
  }

  private launch(craft: Craft): void {
    this.launchedCraft = structuredClone(craft);
    this.game.clearFlightVessels();
    this.game.spawnOnPad(craft, craft.name);
    this.toFlight();
    logEvent(this.game.active!.runtime, this.game.time, `${craft.name} on the pad. Throttle up (Shift) and stage (Space) when ready.`);
  }

  // --------------------------------------------------------------- actions
  private stage(): void {
    const gv = this.game.active;
    if (!gv) return;
    if (this.controlBlocked) {
      logEvent(gv.runtime, this.game.time, 'No signal: cannot command staging.', 'warning');
      return;
    }
    this.game.fireStage(gv);
    this.world.invalidateVessel(gv.runtime.id);
  }

  private toggleMap(): void {
    if (this.screen !== 'flight') return;
    this.map.visible = !this.map.visible;
    this.map.setVisible(this.map.visible);
  }

  private quickSave(): void {
    void writeSave(this.game, 'quick', 'quicksave').then((ok) => {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, ok ? 'Quicksaved.' : 'Quicksave FAILED', ok ? 'info' : 'danger');
    });
  }

  private async quickLoad(): Promise<void> {
    const save = await readSave('quick');
    if (!save) return;
    this.game = restoreGame(save);
    this.world.dispose();
    this.world = new WorldScene();
    if (this.game.active) this.toFlight(false);
    else this.toEditor();
  }

  private revert(): void {
    if (!this.launchedCraft) return;
    this.game.clearFlightVessels();
    this.game.spawnOnPad(structuredClone(this.launchedCraft), this.launchedCraft.name);
    this.game.setWarp(0, false);
    this.toFlight();
  }

  private runScience(): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    const body = this.game.bodyOf(gv);
    const alt = v.pos.length() - body.radius;
    const situation = scienceSituation(v.situation, alt, body.radius, body.def.atmosphere?.height ?? 0);
    if (!situation) {
      logEvent(v, this.game.time, 'No valid science situation right now.', 'warning');
      return;
    }
    let gained = 0;
    for (const p of v.craft.parts) {
      const sci = defOf(p).science;
      if (!sci) continue;
      const exp = EXPERIMENT_INDEX.get(sci.experimentId);
      if (!exp) continue;
      if (!exp.validSituations.includes(situation)) continue;
      if (exp.needsAtmosphere && !body.hasAtmosphere()) continue;
      const key = experimentKey(exp.id, body.id, situation);
      if (this.game.completedExperiments.has(key) || v.scienceData.has(key)) continue;
      const value = experimentValue(exp, body.def.scienceValue);
      v.scienceData.set(key, value);
      gained += value;
      logEvent(v, this.game.time, `${exp.name}: +${value} science stored (${situation} at ${body.name})`);
    }
    if (gained === 0) {
      logEvent(v, this.game.time, 'Nothing new to record here — try a different situation or world.', 'warning');
    }
  }

  private recover(): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    let points = 0;
    for (const val of v.scienceData.values()) points += val;
    for (const key of v.scienceData.keys()) this.game.completedExperiments.add(key);
    this.game.sciencePoints += points;
    this.game.flags.recoveredOnce = true;
    this.game.vessels = this.game.vessels.filter((x) => x !== gv);
    this.game.activeVesselId = null;
    this.world.invalidateVessel(v.id);
    this.showDialog(
      'Vessel recovered',
      `${v.name} is home. Science recovered: ${points} points (total ${this.game.sciencePoints}).` +
        (v.crew.length ? ` Crew ${v.crew.join(', ')} return to a hero's welcome.` : ''),
      [{ label: 'Back to the Workshop', fn: () => this.toEditor() }],
    );
    void writeSave(this.game, 'auto', 'autosave');
  }

  private warpToNode(nodeTime: number): void {
    const eta = nodeTime - this.game.time;
    if (eta < 45) return;
    // Pick the highest rails rate that stops ~30s before the node.
    for (let i = RAILS_WARP_RATES.length - 1; i >= 1; i--) {
      if (eta / RAILS_WARP_RATES[i] > 3) {
        this.game.setWarp(i, true);
        this.pendingWarpStop = nodeTime - 30;
        return;
      }
    }
  }
  private pendingWarpStop: number | null = null;

  private showDialog(title: string, text: string, actions: Array<{ label: string; fn: () => void }>): void {
    this.dialogEl?.remove();
    const d = document.createElement('div');
    d.style.cssText = `
      position: absolute; left: 50%; top: 40%; transform: translate(-50%,-50%);
      background: rgba(14,24,32,0.97); border: 1px solid var(--ui-accent);
      border-radius: 10px; padding: 18px 22px; max-width: 420px; z-index: 80; pointer-events: auto;
    `;
    d.innerHTML = `<div style="font-size:17px;color:#fff;margin-bottom:8px">${title}</div>
      <div style="font-size:13px;color:#c4d2dd;line-height:1.5;margin-bottom:12px">${text}</div>`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = a.label;
      b.onclick = () => {
        d.remove();
        this.dialogEl = null;
        a.fn();
      };
      row.appendChild(b);
    }
    d.appendChild(row);
    this.uiRoot.appendChild(d);
    this.dialogEl = d;
  }

  // ----------------------------------------------------------------- input
  private bindInput(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      this.handleKeyPress(e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragMoved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    canvas.addEventListener('dragover', (e) => {
      if (this.screen !== 'editor') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      this.editor.updatePointer(nx, ny);
    });
    canvas.addEventListener('drop', (e) => {
      if (this.screen !== 'editor') return;
      e.preventDefault();
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      this.editor.updatePointer(nx, ny);
      this.editor.click();
    });
    window.addEventListener('pointermove', (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      if (this.screen === 'editor') this.editor.updatePointer(nx, ny);
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.screen === 'editor') this.editor.orbitCamera(dx, dy);
      else if (this.screen === 'flight' && this.map.visible) this.map.orbitCamera(dx, dy);
      else if (this.screen === 'flight') {
        this.world.camYaw -= dx * 0.005;
        this.world.camPitch = Math.max(-1.4, Math.min(1.4, this.world.camPitch + dy * 0.005));
      }
    });
    window.addEventListener('pointerup', () => {
      if (this.dragging && this.dragMoved < 6 && this.screen === 'editor') {
        this.editor.click();
      }
      this.dragging = false;
    });
    canvas.addEventListener('wheel', (e) => {
      const factor = e.deltaY > 0 ? 1.12 : 0.9;
      if (this.screen === 'editor') this.editor.zoomCamera(factor);
      else if (this.screen === 'flight' && this.map.visible) this.map.zoomCamera(factor);
      else if (this.screen === 'flight') {
        this.world.camDist = Math.max(4, Math.min(2000, this.world.camDist * factor));
      }
      e.preventDefault();
    }, { passive: false });
  }

  private handleKeyPress(e: KeyboardEvent): void {
    const gv = this.game.active;
    if (this.screen === 'editor') {
      if (e.code === 'Delete' || e.code === 'Backspace') this.editor.deleteSelected();
      if (e.code === 'KeyX') {
        (this.editor as unknown as { cycleSymmetry(): void }).cycleSymmetry?.();
      }
      return;
    }
    if (this.screen !== 'flight' || !gv) return;
    const v = gv.runtime;
    switch (e.code) {
      case 'Space':
        this.stage();
        break;
      case 'KeyM':
        this.toggleMap();
        break;
      case 'KeyT':
        v.sas = v.sas === 'off' ? 'stability' : 'off';
        break;
      case 'KeyR':
        v.controls.rcs = !v.controls.rcs;
        break;
      case 'KeyZ':
        v.controls.throttle = 1;
        break;
      case 'KeyX':
        v.controls.throttle = 0;
        break;
      case 'F5':
        e.preventDefault();
        this.quickSave();
        break;
      case 'F9':
        e.preventDefault();
        void this.quickLoad();
        break;
      case 'Comma':
        this.stepWarp(-1);
        break;
      case 'Period':
        this.stepWarp(1);
        break;
      case 'BracketLeft':
        this.cycleVessel(-1);
        break;
      case 'BracketRight':
        this.cycleVessel(1);
        break;
    }
  }

  private cycleVessel(dir: number): void {
    const list = this.game.vessels.filter((gv) => !gv.runtime.isDebris);
    if (list.length < 2) return;
    const idx = list.findIndex((gv) => gv.runtime.id === this.game.activeVesselId);
    const next = list[(idx + dir + list.length) % list.length];
    this.game.setActive(next.runtime.id);
    this.hud.setMissionStart(this.game.time);
  }

  private stepWarp(dir: number): void {
    const g = this.game;
    if (dir > 0) {
      if (!g.railsWarp && g.warpIndex >= PHYSICS_WARP_RATES.length - 1) {
        g.setWarp(1, true);
      } else {
        g.setWarp(g.warpIndex + 1, g.railsWarp);
      }
    } else {
      if (g.railsWarp && g.warpIndex <= 1) g.setWarp(PHYSICS_WARP_RATES.length - 1, false);
      else g.setWarp(g.warpIndex - 1, g.railsWarp);
    }
  }

  private applyContinuousInput(dt: number): void {
    const gv = this.game.active;
    if (!gv || this.screen !== 'flight') return;
    const c = gv.runtime.controls;
    const t = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0;
    const b = this.keys.has('ControlLeft') || this.keys.has('ControlRight') ? 1 : 0;
    c.throttle = Math.max(0, Math.min(1, c.throttle + (t - b) * dt * 0.6));
    c.pitch = (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0);
    c.yaw = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    c.roll = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);
    c.translate.set(
      (this.keys.has('KeyL') ? 1 : 0) - (this.keys.has('KeyJ') ? 1 : 0),
      (this.keys.has('KeyI') ? 1 : 0) - (this.keys.has('KeyK') ? 1 : 0),
      (this.keys.has('KeyO') ? 1 : 0) - (this.keys.has('KeyU') ? 1 : 0),
    );
  }

  // ------------------------------------------------------------------ loop
  private frame(): void {
    const now = performance.now();
    const dtMs = now - this.lastFrame;
    this.lastFrame = now;
    const dt = Math.min(0.1, dtMs / 1000);

    const simStart = this.perf.beginSim();
    if (this.screen === 'flight') {
      // Comms: re-evaluate twice a second; probes need a link for control.
      if (now - this.lastCommsCheck > 500) {
        this.lastCommsCheck = now;
        const gv = this.game.active;
        if (gv) {
          this.comms = evaluateComms(this.game, gv);
          this.controlBlocked = needsCommsForControl(gv) && !this.comms.connected;
          this.hud.setComms(this.comms, this.controlBlocked);
        }
      }
      if (!this.controlBlocked) this.applyContinuousInput(dt);
      this.updateNodeAssist(dt);
      this.game.update(dt);

      // Auto warp stop at node.
      if (this.pendingWarpStop !== null && this.game.time >= this.pendingWarpStop) {
        this.game.setWarp(0, false);
        this.pendingWarpStop = null;
      }

      // Periodic autosave (wall-clock; skips high warp to avoid stutter).
      if (now - this.lastAutosave > 120_000 && this.game.warpRate <= 5) {
        this.lastAutosave = now;
        void writeSave(this.game, 'auto', 'autosave');
      }

      // Destruction dialog.
      if (this.game.lastDestruction) {
        const reason = this.game.lastDestruction.reason;
        this.showDialog('Flight over', `${reason}. The review board recommends... adjustments.`, [
          { label: 'Revert to launch', fn: () => this.revert() },
          { label: 'Back to Workshop', fn: () => this.toEditor() },
        ]);
      }
    }
    this.perf.endSim(simStart);

    const renderStart = performance.now();
    if (this.screen === 'flight') {
      if (this.map.visible) {
        this.map.update(this.game);
        this.ctx.renderer.render(this.map.scene, this.map.camera);
      } else {
        this.world.update(this.game, dt);
        this.ctx.renderer.render(this.world.scene, this.world.camera);
      }
      this.hud.update(this.game, this.map.node);
      if (this.hud.pendingWarpStep !== 0) {
        this.stepWarp(this.hud.pendingWarpStep);
        this.hud.pendingWarpStep = 0;
      }
      const stats = this.world.planetStats();
      this.perf.setExtra('chunks', stats.visible);
    } else if (this.screen === 'editor') {
      this.editor.update();
      this.ctx.renderer.render(this.editor.scene, this.editor.camera);
    } else {
      // Menu: idle starfield via world scene if available.
      this.ctx.renderer.clear();
    }
    this.perf.endRender(renderStart);
    this.perf.frame(dtMs, this.ctx.renderer);

    this.tutorial.update({ game: this.game, editor: this.editor, screen: this.screen });

    if (this.keys.has('F3')) {
      this.keys.delete('F3');
      this.perf.toggle();
    }

    requestAnimationFrame(() => this.frame());
  }

  /** SAS 'node' mode: aim at the planned burn and track remaining Δv. */
  private updateNodeAssist(dt: number): void {
    const gv = this.game.active;
    const node = this.map.node;
    if (!gv || !node) return;
    const v = gv.runtime;
    if (v.sas !== 'node') {
      this.nodeRemainingDv = nodeDeltaV(node);
      return;
    }
    const body = this.game.bodyOf(gv);
    if (v.controls.throttle <= 0.001) {
      // Not burning yet: keep the direction current.
      const els = stateToElements(body.mu, v.pos, v.vel, this.game.time);
      nodeBurnDirection(els, node, this.nodeBurnDir);
      this.nodeRemainingDv = nodeDeltaV(node);
    } else {
      this.nodeRemainingDv -= v.properAccel * dt;
      if (this.nodeRemainingDv <= 0.5) {
        v.controls.throttle = 0;
        logEvent(v, this.game.time, 'Maneuver complete.');
        this.map.node = null;
      }
    }
    v.sasCustomDir.copy(this.nodeBurnDir);
  }
}

export async function startGame(): Promise<void> {
  const game = new PeriluneGame();
  await game.start();
}
