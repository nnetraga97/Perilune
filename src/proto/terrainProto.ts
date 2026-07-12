/**
 * M0 risk prototype: planetary terrain rendering from orbit to ground.
 *
 * Runs an automated camera descent over Veyra — 3000 km orbit down to 3 m
 * above the terrain — while the perf overlay collects frame statistics.
 * Launched with `?proto=terrain`; the e2e harness reads window.__PERF__ and
 * window.__PROTO_DONE__.
 */
import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import { Universe } from '../sim/universe';
import { AUREN_SYSTEM } from '../content/system';
import { surfaceHeight } from '../sim/terrain';
import { PlanetRenderer, PLANET_QUALITY } from '../render/planet';
import { createRenderContext } from '../render/context';
import { PerfOverlay } from '../ui/perfOverlay';
import { makeStarfield } from '../render/starfield';
import { bodyOrientation, inertialToBodyFixed } from '../sim/bodyOrientation';

export async function runTerrainProto(): Promise<void> {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  const ctx = await createRenderContext(canvas);
  const { renderer } = ctx;

  const universe = new Universe(AUREN_SYSTEM);
  const veyra = universe.get('veyra');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#04070a');
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 1e9);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  const sun = new THREE.DirectionalLight('#fff4e0', 2.4);
  sun.position.set(1, 0.4, 0.3).normalize();
  scene.add(sun);
  scene.add(new THREE.AmbientLight('#20303c', 0.5));
  scene.add(makeStarfield(4200));

  const planet = new PlanetRenderer(veyra, PLANET_QUALITY.medium);
  scene.add(planet.group);

  const perf = new PerfOverlay(uiRoot);
  perf.toggle(); // visible during the proto

  document.getElementById('boot')?.remove();

  // Camera path: inertial-frame position relative to Veyra's center (f64).
  const camPos = new Vec3(0, -(veyra.radius + 3.0e6), 0);
  const camBodyFixed = new Vec3();
  const bodyQ = new Quat();
  const originWorld = new Vec3();
  const up = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();

  const start = performance.now();
  let last = start;
  let done = false;
  const DESCENT_S = 45;
  const HOVER_S = 12;

  function frame(): void {
    const now = performance.now();
    const dtMs = now - last;
    last = now;
    const elapsed = (now - start) / 1000;

    const simStart = perf.beginSim();

    // Longitude drift + descent profile (smooth exponential altitude ramp).
    const t = elapsed * 0.5; // universe time, gentle spin
    const phase = Math.min(1, elapsed / DESCENT_S);
    const startAlt = 3.0e6;
    const lon = -0.35 + phase * 0.9;

    // Ground-following altitude target.
    const dirI = new Vec3(Math.sin(lon), -Math.cos(lon), 0.18 * (1 - phase)).normalize();
    const dirBF = inertialToBodyFixed(veyra, t, dirI, new Vec3()).normalize();
    const groundR = veyra.radius + surfaceHeight(veyra, dirBF);
    const endAlt = 3.0;
    const alt = endAlt + (startAlt - endAlt) * Math.pow(1 - phase, 3);
    const r = groundR + alt;
    camPos.copy(dirI).scale(r);

    // Body-fixed camera position for LOD selection.
    inertialToBodyFixed(veyra, t, camPos, camBodyFixed);

    // Floating origin: camera at scene origin; planet center at -camPos.
    originWorld.set(-camPos.x, -camPos.y, -camPos.z);
    planet.update(camBodyFixed, bodyOrientation(veyra, t, bodyQ), originWorld);
    perf.setExtra('chunks', planet.stats.visible);
    perf.setExtra('alt', `${(alt / 1000).toFixed(2)} km`);
    perf.endSim(simStart);

    // Aim: during descent look ahead along travel; when low, look at horizon.
    camera.position.set(0, 0, 0);
    up.set(dirI.x, dirI.y, dirI.z);
    const aheadLon = lon + 0.12;
    const aheadDir = new Vec3(Math.sin(aheadLon), -Math.cos(aheadLon), 0.1 * (1 - phase)).normalize();
    const lookR = phase < 0.99 ? groundR : groundR + alt * 0.8;
    lookTarget.set(
      aheadDir.x * lookR - camPos.x,
      aheadDir.y * lookR - camPos.y,
      aheadDir.z * lookR - camPos.z,
    );
    camera.up.copy(up);
    camera.lookAt(lookTarget);

    const renderStart = performance.now();
    renderer.render(scene, camera);
    perf.endRender(renderStart);
    perf.frame(dtMs, renderer);

    if (elapsed > DESCENT_S + HOVER_S && !done) {
      done = true;
      (window as unknown as { __PROTO_DONE__: boolean }).__PROTO_DONE__ = true;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
