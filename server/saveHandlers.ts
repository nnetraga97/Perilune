import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SaveGame } from '../src/save/schema.js';
import { SAVE_VERSION, validateSave } from '../src/save/validation.js';
import { HttpError, jsonError, jsonOk, methodNotAllowed, readJsonBody, requestId, safeHandlerError } from './http.js';
import { log } from './log.js';
import type { RateLimiter } from './rateLimit.js';
import type { CacheStore } from './redis.js';

const CACHE_TTL_SECONDS = 300;
const SAVE_MAX_BYTES = 2 * 1024 * 1024;
const SLOT = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export interface CloudSaveMeta {
  slot: string;
  label: string;
  saveVersion: number;
  payloadHash: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSaveRecord extends CloudSaveMeta {
  payload: SaveGame;
}

export interface CloudSaveWrite {
  slot: string;
  save: SaveGame;
  payloadHash: string;
}

export interface CloudSaveRepository {
  list(userId: string): Promise<CloudSaveMeta[]>;
  read(userId: string, slot: string): Promise<CloudSaveRecord | null>;
  create(userId: string, input: CloudSaveWrite): Promise<CloudSaveRecord | 'conflict'>;
  update(userId: string, input: CloudSaveWrite & { expectedRevision: number }): Promise<CloudSaveRecord | 'conflict'>;
  delete(userId: string, slot: string, expectedRevision: number): Promise<'deleted' | 'conflict' | 'missing'>;
}

export interface SaveRequestContext {
  userId: string;
  repository: CloudSaveRepository;
}

export interface SaveHandlerDependencies {
  authenticate(request: Request): Promise<SaveRequestContext>;
  cache: CacheStore;
  limiter: RateLimiter;
}

interface PutBody { save?: unknown; expectedRevision?: unknown }
interface DeleteBody { expectedRevision?: unknown }

function rowMeta(row: Record<string, unknown>): CloudSaveMeta {
  return {
    slot: String(row.slot),
    label: String(row.label),
    saveVersion: Number(row.save_version),
    payloadHash: String(row.payload_hash),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowRecord(row: Record<string, unknown>): CloudSaveRecord {
  return { ...rowMeta(row), payload: row.payload as SaveGame };
}

function writeRow(userId: string, input: CloudSaveWrite, revision: number): Record<string, unknown> {
  return {
    user_id: userId,
    slot: input.slot,
    label: input.save.label.slice(0, 120),
    save_version: input.save.saveVersion,
    payload: input.save,
    payload_hash: input.payloadHash,
    revision,
    updated_at: new Date().toISOString(),
  };
}

export function createSupabaseCloudSaveRepository(client: SupabaseClient): CloudSaveRepository {
  return {
    async list(userId) {
      const { data, error } = await client.from('cloud_saves')
        .select('slot,label,save_version,payload_hash,revision,created_at,updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => rowMeta(row as Record<string, unknown>));
    },
    async read(userId, slot) {
      const { data, error } = await client.from('cloud_saves')
        .select('*')
        .eq('user_id', userId)
        .eq('slot', slot)
        .maybeSingle();
      if (error) throw error;
      return data ? rowRecord(data as Record<string, unknown>) : null;
    },
    async create(userId, input) {
      const { data, error } = await client.from('cloud_saves')
        .insert(writeRow(userId, input, 1))
        .select('*')
        .single();
      if (error?.code === '23505') return 'conflict';
      if (error) throw error;
      return rowRecord(data as Record<string, unknown>);
    },
    async update(userId, input) {
      const { data, error } = await client.from('cloud_saves')
        .update(writeRow(userId, input, input.expectedRevision + 1))
        .eq('user_id', userId)
        .eq('slot', input.slot)
        .eq('revision', input.expectedRevision)
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data ? rowRecord(data as Record<string, unknown>) : 'conflict';
    },
    async delete(userId, slot, expectedRevision) {
      const current = await client.from('cloud_saves')
        .select('revision')
        .eq('user_id', userId)
        .eq('slot', slot)
        .maybeSingle();
      if (current.error) throw current.error;
      if (!current.data) return 'missing';
      if (Number(current.data.revision) !== expectedRevision) return 'conflict';
      const result = await client.from('cloud_saves')
        .delete()
        .eq('user_id', userId)
        .eq('slot', slot)
        .eq('revision', expectedRevision)
        .select('slot')
        .maybeSingle();
      if (result.error) throw result.error;
      return result.data ? 'deleted' : 'conflict';
    },
  };
}

function listKey(userId: string): string {
  return `perilune:saves:list:${userId}`;
}

function itemKey(userId: string, slot: string): string {
  return `perilune:saves:item:${userId}:${encodeURIComponent(slot)}`;
}

function validateSlot(raw: string): string {
  const slot = raw.trim().toLowerCase();
  if (!SLOT.test(slot)) throw new HttpError(400, 'INVALID_SLOT', 'Save slot is invalid');
  return slot;
}

function saveHash(save: SaveGame): string {
  return createHash('sha256').update(JSON.stringify(save)).digest('hex');
}

async function rateLimit(
  dependencies: SaveHandlerDependencies,
  scope: 'read' | 'mutation',
  userId: string,
  id: string,
): Promise<Response | null> {
  const result = await dependencies.limiter.consume(scope, userId, scope === 'read' ? 180 : 60, 60);
  return result.allowed ? null : jsonError('RATE_LIMITED', 'Too many cloud save requests', 429, id, {
    'Retry-After': String(result.retryAfterSeconds),
  });
}

export function createSaveCollectionHandler(
  dependencies: SaveHandlerDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = requestId(request);
    const requestLog = log.with({ requestId: id });
    if (request.method !== 'GET') return methodNotAllowed(['GET'], id);
    try {
      const context = await dependencies.authenticate(request);
      const limited = await rateLimit(dependencies, 'read', context.userId, id);
      if (limited) return limited;
      const key = listKey(context.userId);
      const cached = await dependencies.cache.getJson<CloudSaveMeta[]>(key);
      if (cached) {
        requestLog.info('save.read.ok', { status: 200, cache: 'hit' });
        return jsonOk(cached, 200, { 'x-perilune-cache': 'hit' });
      }
      const saves = await context.repository.list(context.userId);
      await dependencies.cache.setJson(key, saves, CACHE_TTL_SECONDS);
      requestLog.info('save.read.ok', { status: 200, cache: 'miss' });
      return jsonOk(saves, 200, { 'x-perilune-cache': 'miss' });
    } catch (error) {
      return safeHandlerError(error, id);
    }
  };
}

export function createSaveItemHandler(
  dependencies: SaveHandlerDependencies,
  rawSlot: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = requestId(request);
    const requestLog = log.with({ requestId: id });
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) return methodNotAllowed(['GET', 'PUT', 'DELETE'], id);
    try {
      const slot = validateSlot(rawSlot);
      const context = await dependencies.authenticate(request);
      const limited = await rateLimit(dependencies, request.method === 'GET' ? 'read' : 'mutation', context.userId, id);
      if (limited) return limited;
      const key = itemKey(context.userId, slot);

      if (request.method === 'GET') {
        const cached = await dependencies.cache.getJson<CloudSaveRecord>(key);
        if (cached) {
          requestLog.info('save.read.ok', { status: 200, cache: 'hit' });
          return jsonOk(cached, 200, { 'x-perilune-cache': 'hit' });
        }
        const record = await context.repository.read(context.userId, slot);
        if (!record) {
          requestLog.info('save.read.miss', { status: 404 });
          return jsonError('SAVE_NOT_FOUND', 'Cloud save was not found', 404, id);
        }
        await dependencies.cache.setJson(key, record, CACHE_TTL_SECONDS);
        requestLog.info('save.read.ok', { status: 200, cache: 'miss' });
        return jsonOk(record, 200, { 'x-perilune-cache': 'miss' });
      }

      if (request.method === 'PUT') {
        const body = await readJsonBody<PutBody>(request, SAVE_MAX_BYTES);
        if (!validateSave(body.save) || body.save.saveVersion < 1 || body.save.saveVersion > SAVE_VERSION) {
          requestLog.info('save.write.invalid', { status: 400, reason: 'invalid_or_unsupported' });
          throw new HttpError(400, 'INVALID_SAVE', 'Save data is invalid or unsupported');
        }
        const expected = body.expectedRevision;
        if (expected !== null && expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1)) {
          throw new HttpError(400, 'INVALID_REVISION', 'Expected revision is invalid');
        }
        const input: CloudSaveWrite = { slot, save: body.save, payloadHash: saveHash(body.save) };
        const result = expected === null || expected === undefined
          ? await context.repository.create(context.userId, input)
          : await context.repository.update(context.userId, { ...input, expectedRevision: Number(expected) });
        if (result === 'conflict') {
          requestLog.warn('save.write.conflict', { status: 409 });
          return jsonError('SAVE_CONFLICT', 'Cloud save changed on another device', 409, id);
        }
        await dependencies.cache.delete(key, listKey(context.userId));
        const status = expected === null || expected === undefined ? 201 : 200;
        requestLog.info('save.write.ok', {
          status, payloadHash: input.payloadHash, payloadBytes: JSON.stringify(body.save).length,
        });
        return jsonOk(result, status);
      }

      const body = await readJsonBody<DeleteBody>(request, 16 * 1024);
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
        throw new HttpError(400, 'INVALID_REVISION', 'Expected revision is required');
      }
      const result = await context.repository.delete(context.userId, slot, Number(body.expectedRevision));
      if (result === 'conflict') {
        requestLog.warn('save.delete.conflict', { status: 409 });
        return jsonError('SAVE_CONFLICT', 'Cloud save changed on another device', 409, id);
      }
      if (result === 'missing') {
        requestLog.info('save.delete.missing', { status: 404 });
        return jsonError('SAVE_NOT_FOUND', 'Cloud save was not found', 404, id);
      }
      await dependencies.cache.delete(key, listKey(context.userId));
      requestLog.info('save.delete.ok', { status: 200 });
      return jsonOk({ deleted: true });
    } catch (error) {
      return safeHandlerError(error, id);
    }
  };
}
