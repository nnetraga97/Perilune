import { createClient, type RedisClientType } from 'redis';
import type { ServerEnv } from './env.js';
import { log } from './log.js';

export interface CacheStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  increment(key: string, windowSeconds: number): Promise<{
    count: number;
    ttlSeconds: number;
    available?: boolean;
  }>;
}

let clientPromise: Promise<RedisClientType | null> | null = null;

async function connectedClient(url: string | null): Promise<RedisClientType | null> {
  if (!url) return null;
  if (!clientPromise) {
    const client = createClient({ url });
    client.on('error', (error) => log.warn('dep.redis.unavailable', {
      operation: 'client', reason: error instanceof Error ? error.message : 'unknown',
    }));
    clientPromise = client.connect().then(() => client as RedisClientType).catch((error) => {
      log.warn('dep.redis.unavailable', {
        operation: 'connect', reason: error instanceof Error ? error.message : 'unknown',
      });
      clientPromise = null;
      return null;
    });
  }
  return clientPromise;
}

export function createCacheStore(env: Pick<ServerEnv, 'redisUrl'>): CacheStore {
  return {
    async getJson<T>(key: string): Promise<T | null> {
      try {
        const raw = await (await connectedClient(env.redisUrl))?.get(key);
        return raw ? JSON.parse(raw) as T : null;
      } catch (error) {
        log.warn('dep.redis.unavailable', {
          operation: 'cache_read', reason: error instanceof Error ? error.message : 'unknown',
        });
        return null;
      }
    },
    async setJson(key, value, ttlSeconds): Promise<void> {
      try {
        await (await connectedClient(env.redisUrl))?.set(key, JSON.stringify(value), { EX: ttlSeconds });
      } catch (error) {
        log.warn('dep.redis.unavailable', {
          operation: 'cache_write', reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    },
    async delete(...keys): Promise<void> {
      if (!keys.length) return;
      try {
        await (await connectedClient(env.redisUrl))?.del(keys);
      } catch (error) {
        log.warn('dep.redis.unavailable', {
          operation: 'cache_invalidate', reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    },
    async increment(key, windowSeconds): Promise<{
      count: number;
      ttlSeconds: number;
      available?: boolean;
    }> {
      const client = await connectedClient(env.redisUrl);
      if (!client) return { count: 0, ttlSeconds: windowSeconds, available: false };
      try {
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, windowSeconds);
        const ttl = await client.ttl(key);
        return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds, available: true };
      } catch (error) {
        log.warn('dep.redis.unavailable', {
          operation: 'rate_limit', reason: error instanceof Error ? error.message : 'unknown',
        });
        return { count: 0, ttlSeconds: windowSeconds, available: false };
      }
    },
  };
}
