/**
 * Save persistence: serialize GameState ⇄ SaveGame, and store slots in
 * IndexedDB (localStorage fallback for environments without IDB).
 * Transactional writes with backup rotation; corrupted saves are detected
 * before they can replace good data.
 */
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import { GameState, GameVessel } from '../sim/state';
import { createVesselRuntime, refreshDerived } from '../sim/flight';
import type { Craft, PartInstance, AttachKind } from '../sim/vessel';
import type { ResourceId } from '../content/parts';
import {
  migrateSave,
  SaveGame,
  SavedSurfacePose,
  SavedVessel,
  SAVE_VERSION,
  validateSave,
} from './schema';
import {
  bodyFixedAttitudeToInertial,
  bodyFixedToInertial,
  inertialAttitudeToBodyFixed,
  inertialToBodyFixed,
  surfaceVelocity,
} from '../sim/bodyOrientation';
import { contactSurface } from '../sim/terrain';
import { recipeForBody } from '../sim/terrainRecipe';

function isSurfaceSituation(situation: SavedVessel['situation']): boolean {
  return situation === 'prelaunch' || situation === 'landed' || situation === 'splashed';
}

function serializeSurfacePose(game: GameState, gv: GameVessel): SavedSurfacePose | null {
  const vessel = gv.runtime;
  if (!isSurfaceSituation(vessel.situation)) return null;
  const body = game.bodyOf(gv);
  if (body.def.surfaceKind !== 'solid') return null;
  const positionBF = gv.regime === 'rails' && gv.rails.landedPos
    ? gv.rails.landedPos.clone()
    : inertialToBodyFixed(body, game.time, vessel.pos, new Vec3());
  const directionBF = positionBF.clone().normalize();
  const surface = contactSurface(body, directionBF);
  if (surface.kind === 'none') return null;
  const attitudeBF = gv.regime === 'rails' && gv.rails.landedAtt
    ? gv.rails.landedAtt.clone()
    : inertialAttitudeToBodyFixed(body, game.time, vessel.att, new Quat());
  const recipe = recipeForBody(body);
  return {
    bodyId: body.id,
    recipeHash: recipe.hash,
    scatterRecipeHash: recipe.hash,
    directionBF: { ...directionBF },
    attitudeBF: { ...attitudeBF },
    contactOffset: positionBF.length() - (body.radius + surface.height),
  };
}

// ------------------------------------------------------------ serialization

export function serializeGame(game: GameState, label: string): SaveGame {
  const vessels: SavedVessel[] = game.vessels.map((gv) => {
    const v = gv.runtime;
    return {
      id: v.id,
      name: v.name,
      craft: {
        name: v.craft.name,
        version: v.craft.version,
        parts: v.craft.parts.map((p) => ({
          key: p.key,
          defId: p.defId,
          parentKey: p.parentKey,
          attach: p.attach,
          position: { ...p.position },
          rotation: { ...p.rotation },
          resources: { ...p.resources } as Record<string, number>,
          symmetry: p.symmetry,
          activated: p.activated,
          deployed: p.deployed,
          temperature: p.temperature,
        })),
        stages: v.craft.stages.map((s) => ({ partKeys: [...s.partKeys] })),
        nextKey: v.craft.nextKey,
      },
      bodyId: v.bodyId,
      regime: gv.regime,
      pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
      vel: { x: v.vel.x, y: v.vel.y, z: v.vel.z },
      att: { x: v.att.x, y: v.att.y, z: v.att.z, w: v.att.w },
      angVel: { x: v.angVel.x, y: v.angVel.y, z: v.angVel.z },
      situation: v.situation,
      sas: v.sas,
      throttle: v.controls.throttle,
      currentStage: v.currentStage,
      isDebris: v.isDebris,
      crew: [...v.crew],
      charge: v.charge.amount,
      science: Object.fromEntries(v.scienceData),
      railsElements: gv.rails.elements ? { ...gv.rails.elements } : null,
      railsLandedPos: gv.rails.landedPos
        ? { x: gv.rails.landedPos.x, y: gv.rails.landedPos.y, z: gv.rails.landedPos.z }
        : null,
      railsLandedAtt: gv.rails.landedAtt
        ? { x: gv.rails.landedAtt.x, y: gv.rails.landedAtt.y, z: gv.rails.landedAtt.z, w: gv.rails.landedAtt.w }
        : null,
      surfacePose: serializeSurfacePose(game, gv),
    };
  });

  return {
    saveVersion: SAVE_VERSION,
    createdAt: Date.now(),
    label,
    time: game.time,
    activeVesselId: game.activeVesselId,
    vessels,
    science: { points: game.sciencePoints, completed: [...game.completedExperiments] },
    flags: { ...game.flags },
    isru: { scanned: [...game.scannedBodies] },
    alarms: game.alarms.map((alarm) => ({ ...alarm })),
  };
}

export function restoreGame(save: SaveGame): GameState {
  const migrated = migrateSave(save);
  const game = new GameState();
  game.time = migrated.time;
  game.activeVesselId = migrated.activeVesselId;
  game.sciencePoints = migrated.science?.points ?? 0;
  game.completedExperiments = new Set(migrated.science?.completed ?? []);
  game.flags = { ...(migrated.flags ?? {}) };
  game.scannedBodies = new Set(migrated.isru?.scanned ?? []);
  game.restoreAlarms(migrated.alarms);

  // Validate every referenced recipe before constructing any vessel state.
  for (const vessel of migrated.vessels) {
    if (!vessel.surfacePose) continue;
    const body = game.universe.get(vessel.bodyId);
    const currentRecipeHash = recipeForBody(body).hash;
    if (currentRecipeHash !== vessel.surfacePose.recipeHash) {
      throw new Error(
        `Unavailable terrain recipe ${vessel.surfacePose.recipeHash} for ${body.name}`,
      );
    }
    if (currentRecipeHash !== vessel.surfacePose.scatterRecipeHash) {
      throw new Error(
        `Unavailable physical-scatter recipe ${vessel.surfacePose.scatterRecipeHash} for ${body.name}`,
      );
    }
  }

  for (const sv of migrated.vessels) {
    const craft: Craft = {
      name: sv.craft.name,
      version: sv.craft.version,
      parts: sv.craft.parts.map(
        (p): PartInstance => ({
          key: p.key,
          defId: p.defId,
          parentKey: p.parentKey,
          attach: p.attach as AttachKind,
          position: { ...p.position },
          rotation: { ...p.rotation },
          resources: { ...p.resources } as Partial<Record<ResourceId, number>>,
          symmetry: p.symmetry,
          activated: p.activated,
          deployed: p.deployed,
          temperature: p.temperature,
        }),
      ),
      stages: sv.craft.stages.map((s) => ({ partKeys: [...s.partKeys] })),
      nextKey: sv.craft.nextKey,
    };
    const runtime = createVesselRuntime(sv.id, sv.name, craft, sv.bodyId);
    runtime.pos.set(sv.pos.x, sv.pos.y, sv.pos.z);
    runtime.vel.set(sv.vel.x, sv.vel.y, sv.vel.z);
    runtime.att.set(sv.att.x, sv.att.y, sv.att.z, sv.att.w);
    runtime.angVel.set(sv.angVel.x, sv.angVel.y, sv.angVel.z);
    runtime.situation = sv.situation;
    runtime.sas = sv.sas;
    runtime.controls.throttle = sv.throttle;
    runtime.currentStage = sv.currentStage;
    runtime.isDebris = sv.isDebris;
    runtime.crew = [...sv.crew];
    runtime.charge.amount = sv.charge;
    runtime.scienceData = new Map(Object.entries(sv.science ?? {}));
    refreshDerived(runtime);
    // refreshDerived clamps charge; restore exact amount afterward.
    runtime.charge.amount = Math.min(sv.charge, runtime.charge.capacity);

    let landedPos: Vec3 | null = sv.railsLandedPos
      ? new Vec3(sv.railsLandedPos.x, sv.railsLandedPos.y, sv.railsLandedPos.z)
      : null;
    let landedAtt: Quat | null = sv.railsLandedAtt
      ? new Quat(sv.railsLandedAtt.x, sv.railsLandedAtt.y, sv.railsLandedAtt.z, sv.railsLandedAtt.w)
      : null;

    if (isSurfaceSituation(sv.situation)) {
      const body = game.universe.get(sv.bodyId);
      let directionBF: Vec3;
      let attitudeBF: Quat;
      let contactOffset: number;
      if (sv.surfacePose) {
        directionBF = new Vec3(
          sv.surfacePose.directionBF.x,
          sv.surfacePose.directionBF.y,
          sv.surfacePose.directionBF.z,
        ).normalize();
        attitudeBF = new Quat(
          sv.surfacePose.attitudeBF.x,
          sv.surfacePose.attitudeBF.y,
          sv.surfacePose.attitudeBF.z,
          sv.surfacePose.attitudeBF.w,
        ).normalize();
        contactOffset = sv.surfacePose.contactOffset;
      } else {
        // Version 3 and older stored an inertial pose under a Z-only spin model.
        const legacyPosition = landedPos ?? new Vec3(sv.pos.x, sv.pos.y, sv.pos.z);
        if (landedPos) {
          directionBF = legacyPosition.clone().normalize();
        } else {
          const spin = -body.rotationAngle(migrated.time);
          const c = Math.cos(spin);
          const s = Math.sin(spin);
          directionBF = new Vec3(
            legacyPosition.x * c - legacyPosition.y * s,
            legacyPosition.x * s + legacyPosition.y * c,
            legacyPosition.z,
          ).normalize();
        }
        const legacySpinInverse = new Quat().setFromAxisAngle(
          new Vec3(0, 0, 1),
          -body.rotationAngle(migrated.time),
        );
        attitudeBF = legacySpinInverse.multiply(
          new Quat(sv.att.x, sv.att.y, sv.att.z, sv.att.w),
        ).normalize();
        const oldSurface = contactSurface(body, directionBF);
        if (oldSurface.kind === 'none') {
          throw new Error(`Cannot migrate landed pose for ${body.name}: no contact surface`);
        }
        contactOffset = legacyPosition.length() - (body.radius + oldSurface.height);
      }

      const surface = contactSurface(body, directionBF);
      if (surface.kind === 'none') {
        throw new Error(`Cannot restore landed pose for ${body.name}: no contact surface`);
      }
      landedPos = directionBF.clone().scale(body.radius + surface.height + contactOffset);
      landedAtt = attitudeBF;
      bodyFixedToInertial(body, migrated.time, landedPos, runtime.pos);
      bodyFixedAttitudeToInertial(body, migrated.time, landedAtt, runtime.att);
      surfaceVelocity(body, runtime.pos, runtime.vel);
    }

    const gv: GameVessel = {
      runtime,
      regime: sv.regime,
      rails: {
        elements: sv.railsElements ? { ...sv.railsElements } : null,
        landedPos,
        landedAtt,
      },
    };
    game.vessels.push(gv);
    game.noteRestoredVessel(sv.id);
  }
  return game;
}

// --------------------------------------------------------------- storage

const DB_NAME = 'perilune';
const STORE = 'saves';
const BACKUPS = 3;

interface SaveSlotMeta {
  slot: string;
  label: string;
  createdAt: number;
  time: number;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function idbPut(key: string, value: string): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    try {
      localStorage.setItem(`perilune:${key}`, value);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) {
    return localStorage.getItem(`perilune:${key}`);
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
    req.onerror = () => resolve(null);
  });
}

async function idbKeys(): Promise<string[]> {
  const db = await openDb();
  if (!db) {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('perilune:')) keys.push(k.slice('perilune:'.length));
    }
    return keys;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve((req.result as string[]) ?? []);
    req.onerror = () => resolve([]);
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    localStorage.removeItem(`perilune:${key}`);
    return;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Write a save transactionally: serialize, verify round-trip, rotate
 * backups, then store. Returns false (and leaves old data intact) on any
 * failure.
 */
export async function writeSave(game: GameState, slot: string, label: string): Promise<boolean> {
  try {
    const save = serializeGame(game, label);
    const json = JSON.stringify(save);
    // Verify what we are about to store actually parses + validates.
    const parsed = JSON.parse(json) as unknown;
    if (!validateSave(parsed)) {
      console.error('Save failed validation; refusing to write.');
      return false;
    }
    // Rotate backups: slot.bak2 ← slot.bak1 ← slot
    const current = await idbGet(`save:${slot}`);
    if (current) {
      const bak1 = await idbGet(`save:${slot}.bak1`);
      if (bak1) await idbPut(`save:${slot}.bak2`, bak1);
      await idbPut(`save:${slot}.bak1`, current);
    }
    return await idbPut(`save:${slot}`, json);
  } catch (err) {
    console.error('writeSave error:', err);
    return false;
  }
}

/** Load a save slot, falling back to backups if the primary is corrupt. */
export async function readSave(slot: string): Promise<SaveGame | null> {
  for (const suffix of ['', '.bak1', '.bak2']) {
    const json = await idbGet(`save:${slot}${suffix}`);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (validateSave(parsed)) {
        if (suffix) console.warn(`Loaded backup save ${slot}${suffix} (primary corrupt).`);
        return migrateSave(parsed);
      }
    } catch {
      // try next backup
    }
  }
  return null;
}

export async function listSaves(): Promise<SaveSlotMeta[]> {
  const keys = await idbKeys();
  const out: SaveSlotMeta[] = [];
  for (const key of keys) {
    if (!key.startsWith('save:') || key.includes('.bak')) continue;
    const json = await idbGet(key);
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as SaveGame;
      out.push({
        slot: key.slice('save:'.length),
        label: parsed.label,
        createdAt: parsed.createdAt,
        time: parsed.time,
      });
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSave(slot: string): Promise<void> {
  await idbDelete(`save:${slot}`);
  await idbDelete(`save:${slot}.bak1`);
  await idbDelete(`save:${slot}.bak2`);
}

// Craft library (editor save/load of designs)
export async function writeCraftFile(name: string, craft: Craft): Promise<boolean> {
  try {
    const json = JSON.stringify(craft);
    JSON.parse(json); // sanity
    return await idbPut(`craft:${name}`, json);
  } catch {
    return false;
  }
}

export async function readCraftFile(name: string): Promise<Craft | null> {
  const json = await idbGet(`craft:${name}`);
  if (!json) return null;
  try {
    const craft = JSON.parse(json) as Craft;
    if (!Array.isArray(craft.parts)) return null;
    return craft;
  } catch {
    return null;
  }
}

export async function listCraftFiles(): Promise<string[]> {
  const keys = await idbKeys();
  return keys.filter((k) => k.startsWith('craft:')).map((k) => k.slice('craft:'.length));
}
