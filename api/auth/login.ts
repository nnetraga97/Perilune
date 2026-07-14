import { createAuthHandler } from '../../server/authHandlers.js';
import { serverEnv } from '../../server/env.js';
import { requestId, safeHandlerError } from '../../server/http.js';
import { createCacheStore } from '../../server/redis.js';
import { RateLimiter } from '../../server/rateLimit.js';
import { createAuthClient } from '../../server/supabase.js';

let handler: ((request: Request) => Promise<Response>) | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (!handler) {
        const env = serverEnv();
        handler = createAuthHandler('login', {
          supabase: createAuthClient(env),
          limiter: new RateLimiter(createCacheStore(env)),
        });
      }
      return await handler(request);
    } catch (error) {
      return safeHandlerError(error, requestId(request));
    }
  },
};
