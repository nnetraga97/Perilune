import { createFlightDirectorHandler, createOpenAIFlightDirectorProvider } from './flightDirector.js';
import { HttpError, requestId, safeHandlerError } from './http.js';
import { RateLimiter } from './rateLimit.js';
import { createCacheStore, type CacheStore } from './redis.js';

interface MemoryEntry { value: unknown; expiresAt: number }
interface MemoryCounter { count: number; expiresAt: number }

function createMemoryCache(): CacheStore {
  const values = new Map<string, MemoryEntry>();
  const counters = new Map<string, MemoryCounter>();
  return {
    async getJson<T>(key: string): Promise<T | null> {
      const entry = values.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        values.delete(key);
        return null;
      }
      return entry.value as T;
    },
    async setJson(key, value, ttlSeconds): Promise<void> {
      values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async delete(...keys): Promise<void> {
      keys.forEach((key) => values.delete(key));
    },
    async increment(key, windowSeconds) {
      const now = Date.now();
      const current = counters.get(key);
      const next = !current || current.expiresAt <= now
        ? { count: 1, expiresAt: now + windowSeconds * 1000 }
        : { ...current, count: current.count + 1 };
      counters.set(key, next);
      return {
        count: next.count,
        ttlSeconds: Math.max(1, Math.ceil((next.expiresAt - now) / 1000)),
        available: true,
      };
    },
  };
}

let handler: ((request: Request) => Promise<Response>) | null = null;

function runtimeHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new HttpError(503, 'AI_NOT_CONFIGURED', 'AI flight briefings are not configured');
  const redisUrl = process.env.REDIS_URL?.trim() || null;
  const production = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (production && !redisUrl) {
    throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Production AI rate limiting is not configured');
  }
  const cache = redisUrl ? createCacheStore({ redisUrl }) : createMemoryCache();
  handler = createFlightDirectorHandler({
    provider: createOpenAIFlightDirectorProvider(apiKey),
    limiter: new RateLimiter(cache),
    cache,
  });
  return handler;
}

export async function flightDirectorRuntimeHandler(request: Request): Promise<Response> {
  try {
    return await runtimeHandler()(request);
  } catch (error) {
    return safeHandlerError(error, requestId(request));
  }
}
