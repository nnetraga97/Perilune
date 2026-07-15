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
import {
  ACTION_GROUP_IDS,
  type ActionGroupId,
  type ActionGroups,
  type AttachKind,
  type Craft,
  type PartAction,
  type PartInstance,
} from '../sim/vessel';
import { partById, type ResourceId } from '../content/parts';
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
import { scatterRecipeForBody } from '../sim/scatterRecipe';
import { sanitizeInterstageShroudSpec } from '../sim/interstage';

function cloneActionGroups(groups: Readonly<ActionGroups>): ActionGroups {
  const clone: ActionGroups = {};
  for (const group of ACTION_GROUP_IDS) {
    const assignments = groups[group];
    if (assignments?.length) clone[group] = assignments.map((assignment) => ({ ...assignment }));
  }
  return clone;
}

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
    scatterRecipeHash: scatterRecipeForBody(body).hash,
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
          interstageShroud: p.interstageShroud ? { ...p.interstageShroud } : undefined,
        })),
        stages: v.craft.stages.map((s) => ({ partKeys: [...s.partKeys] })),
        actionGroups: cloneActionGroups(v.craft.actionGroups),
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
      target: gv.target,
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
    const body = game.universe.get(vessel.bodyId);
    if (vessel.target !== null) game.universe.get(vessel.target);
    if (isSurfaceSituation(vessel.situation) && body.def.surfaceKind !== 'solid') {
      throw new Error(`${body.name} is a gas body with no solid surface for landed saves`);
    }
    if (!vessel.surfacePose) continue;
    const pose = vessel.surfacePose;
    const currentRecipeHash = recipeForBody(body).hash;
    if (currentRecipeHash !== pose.recipeHash) {
      throw new Error(
        `Unavailable terrain recipe ${pose.recipeHash} for ${body.name}`,
      );
    }
    const currentScatterHash = scatterRecipeForBody(body).hash;
    // Version-4 saves aliased the scatter hash to the terrain hash; adopt the
    // body's declared scatter recipe for those poses. Genuine version-5 hashes
    // must match the currently declared recipe or the load stops before mutating.
    const savedScatterHash = pose.scatterRecipeHash === pose.recipeHash
      ? currentScatterHash
      : pose.scatterRecipeHash;
    if (savedScatterHash !== currentScatterHash) {
      throw new Error(
        `Unavailable physical-scatter recipe ${pose.scatterRecipeHash} for ${body.name}`,
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
          interstageShroud: p.interstageShroud
            ? sanitizeInterstageShroudSpec(p.interstageShroud) ?? undefined
            : undefined,
        }),
      ),
      stages: sv.craft.stages.map((s) => ({ partKeys: [...s.partKeys] })),
      actionGroups: cloneActionGroups(sv.craft.actionGroups),
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
      target: sv.target,
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

export interface SaveSlotMeta {
  slot: string;
  label: string;
  createdAt: number;
  time: number;
  vesselCount: number;
  activeVesselName: string | null;
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
    return await writeSaveDocument(slot, save);
  } catch (err) {
    console.error('writeSave error:', err);
    return false;
  }
}

/** Persist an already serialized save through the same validation and backup rotation. */
export async function writeSaveDocument(slot: string, save: SaveGame): Promise<boolean> {
  try {
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
    console.error('writeSaveDocument error:', err);
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
        vesselCount: parsed.vessels.length,
        activeVesselName: parsed.vessels.find((vessel) => vessel.id === parsed.activeVesselId)?.name ?? null,
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

const CRAFT_NAME_MAX_LENGTH = 80;
const ATTACH_KINDS: readonly AttachKind[] = ['root', 'stack-top', 'stack-bottom', 'surface'];
const PART_ACTIONS: readonly PartAction[] = ['toggle', 'activate', 'deactivate'];

function actionGroupId(value: string): ActionGroupId | null {
  const parsed = Number(value);
  return ACTION_GROUP_IDS.includes(parsed as ActionGroupId) ? parsed as ActionGroupId : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function vectorTriple(value: unknown): { x: number; y: number; z: number } | null {
  const v = value as { x?: unknown; y?: unknown; z?: unknown } | null;
  if (!v || !finiteNumber(v.x) || !finiteNumber(v.y) || !finiteNumber(v.z)) return null;
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Structural validation for craft files: they are user-authored data that may
 * have been shared between players, so every field is checked and rebuilt
 * instead of being trusted (unknown parts, non-finite numbers, dangling keys,
 * or oversized names reject the file). Returns a fresh sanitized object.
 */
export function validateCraftFile(raw: unknown): Craft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.name !== 'string' || data.name.length === 0) return null;
  if (!finiteNumber(data.version) || !Array.isArray(data.parts) || !Array.isArray(data.stages)) return null;

  const parts: PartInstance[] = [];
  const keys = new Set<number>();
  for (const rawPart of data.parts) {
    const part = rawPart as Record<string, unknown>;
    if (!Number.isInteger(part.key) || keys.has(part.key as number)) return null;
    if (typeof part.defId !== 'string') return null;
    try {
      partById(part.defId);
    } catch {
      return null;
    }
    if (part.parentKey !== null && !Number.isInteger(part.parentKey)) return null;
    if (!ATTACH_KINDS.includes(part.attach as AttachKind)) return null;
    const position = vectorTriple(part.position);
    const rotationBase = vectorTriple(part.rotation);
    const rotationW = (part.rotation as { w?: unknown } | null)?.w;
    if (!position || !rotationBase || !finiteNumber(rotationW)) return null;
    const resources: Partial<Record<ResourceId, number>> = {};
    if (typeof part.resources !== 'object' || part.resources === null) return null;
    for (const [resource, amount] of Object.entries(part.resources)) {
      if (!finiteNumber(amount) || amount < 0) return null;
      resources[resource as ResourceId] = amount;
    }
    if (!Number.isInteger(part.symmetry)) return null;
    const interstageShroud = part.interstageShroud === undefined
      ? undefined
      : sanitizeInterstageShroudSpec(part.interstageShroud);
    if (part.interstageShroud !== undefined && !interstageShroud) return null;
    keys.add(part.key as number);
    parts.push({
      key: part.key as number,
      defId: part.defId,
      parentKey: part.parentKey as number | null,
      attach: part.attach as AttachKind,
      position,
      rotation: { ...rotationBase, w: rotationW },
      resources,
      symmetry: part.symmetry as number,
      ...(typeof part.activated === 'boolean' ? { activated: part.activated } : {}),
      ...(typeof part.deployed === 'boolean' ? { deployed: part.deployed } : {}),
      ...(finiteNumber(part.temperature) ? { temperature: part.temperature } : {}),
      ...(interstageShroud ? { interstageShroud } : {}),
    });
  }
  for (const part of parts) {
    if (part.parentKey !== null && !keys.has(part.parentKey)) return null;
  }

  const stages: Craft['stages'] = [];
  for (const rawStage of data.stages) {
    const stage = rawStage as Record<string, unknown>;
    if (!Array.isArray(stage.partKeys)) return null;
    const partKeys: number[] = [];
    for (const key of stage.partKeys) {
      if (!Number.isInteger(key) || !keys.has(key as number)) return null;
      partKeys.push(key as number);
    }
    stages.push({ partKeys });
  }

  const actionGroups: ActionGroups = {};
  if (data.actionGroups !== undefined) {
    if (
      typeof data.actionGroups !== 'object'
      || data.actionGroups === null
      || Array.isArray(data.actionGroups)
    ) return null;
    for (const [rawGroup, rawAssignments] of Object.entries(data.actionGroups)) {
      const group = actionGroupId(rawGroup);
      if (group === null || !Array.isArray(rawAssignments)) return null;
      const assignments = [];
      for (const rawAssignment of rawAssignments) {
        if (typeof rawAssignment !== 'object' || rawAssignment === null) return null;
        const assignment = rawAssignment as Record<string, unknown>;
        if (!Number.isInteger(assignment.partKey)) return null;
        if (!PART_ACTIONS.includes(assignment.action as PartAction)) return null;
        // Shared craft files may refer to a part removed by an older editor;
        // discard that stale binding while preserving all valid assignments.
        if (!keys.has(assignment.partKey as number)) continue;
        assignments.push({
          partKey: assignment.partKey as number,
          action: assignment.action as PartAction,
        });
      }
      if (assignments.length) actionGroups[group] = assignments;
    }
  }

  const maxKey = parts.reduce((max, part) => Math.max(max, part.key), 0);
  const nextKey = Number.isInteger(data.nextKey) && (data.nextKey as number) > maxKey
    ? (data.nextKey as number)
    : maxKey + 1;

  return {
    name: data.name.slice(0, CRAFT_NAME_MAX_LENGTH),
    version: data.version,
    parts,
    stages,
    actionGroups,
    nextKey,
  };
}

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
    return validateCraftFile(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}

export async function listCraftFiles(): Promise<string[]> {
  const keys = await idbKeys();
  return keys.filter((k) => k.startsWith('craft:')).map((k) => k.slice('craft:'.length));
}

export async function deleteCraftFile(name: string): Promise<void> {
  await idbDelete(`craft:${name}`);
}
