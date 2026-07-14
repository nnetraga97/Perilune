import { createClient, type RedisClientType } from 'redis';
import type { ServerEnv } from './env.js';
import { captureServerWarning } from './sentry.js';

export interface CacheStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  increment(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}

let clientPromise: Promise<RedisClientType | null> | null = null;

async function connectedClient(url: string | null): Promise<RedisClientType | null> {
  if (!url) return null;
  if (!clientPromise) {
    const client = createClient({ url });
    client.on('error', (error) => console.warn('Redis client error', error instanceof Error ? error.message : 'unknown'));
    clientPromise = client.connect().then(() => client as RedisClientType).catch((error) => {
      console.warn('Redis connection unavailable', error instanceof Error ? error.message : 'unknown');
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
        captureServerWarning('cache_read', 'redis');
        console.warn('Redis cache read failed', error instanceof Error ? error.message : 'unknown');
        return null;
      }
    },
    async setJson(key, value, ttlSeconds): Promise<void> {
      try {
        await (await connectedClient(env.redisUrl))?.set(key, JSON.stringify(value), { EX: ttlSeconds });
      } catch (error) {
        captureServerWarning('cache_write', 'redis');
        console.warn('Redis cache write failed', error instanceof Error ? error.message : 'unknown');
      }
    },
    async delete(...keys): Promise<void> {
      if (!keys.length) return;
      try {
        await (await connectedClient(env.redisUrl))?.del(keys);
      } catch (error) {
        captureServerWarning('cache_invalidate', 'redis');
        console.warn('Redis cache invalidation failed', error instanceof Error ? error.message : 'unknown');
      }
    },
    async increment(key, windowSeconds): Promise<{ count: number; ttlSeconds: number }> {
      const client = await connectedClient(env.redisUrl);
      if (!client) return { count: 0, ttlSeconds: windowSeconds };
      try {
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, windowSeconds);
        const ttl = await client.ttl(key);
        return { count, ttlSeconds: ttl > 0 ? ttl : windowSeconds };
      } catch (error) {
        captureServerWarning('rate_limit', 'redis');
        console.warn('Redis rate limit unavailable', error instanceof Error ? error.message : 'unknown');
        return { count: 0, ttlSeconds: windowSeconds };
      }
    },
  };
}
