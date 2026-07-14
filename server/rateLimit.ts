import { createHash } from 'node:crypto';
import type { CacheStore } from './redis.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  backendAvailable: boolean;
}

export function rateLimitIdentity(value: string, ip: string): string {
  return createHash('sha256').update(`${value.trim().toLowerCase()}\n${ip}`).digest('hex');
}

export function rateLimitIpIdentity(ip: string): string {
  return createHash('sha256').update(`ip\n${ip}`).digest('hex');
}

export class RateLimiter {
  constructor(private readonly cache: CacheStore) {}

  async consume(
    scope: string,
    identity: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const result = await this.cache.increment(`perilune:limit:${scope}:${identity}`, windowSeconds);
    const backendAvailable = result.available !== false;
    return {
      allowed: backendAvailable && result.count <= limit,
      retryAfterSeconds: result.ttlSeconds,
      backendAvailable,
    };
  }
}
