import { serverEnv } from './env.js';
import { requestId, safeHandlerError } from './http.js';
import { RateLimiter } from './rateLimit.js';
import { createCacheStore } from './redis.js';
import {
  createSaveCollectionHandler,
  createSaveItemHandler,
  createSupabaseCloudSaveRepository,
  type SaveHandlerDependencies,
} from './saveHandlers.js';
import { createUserScopedClient, verifyUser } from './supabase.js';

let dependencies: SaveHandlerDependencies | null = null;

function runtimeDependencies(): SaveHandlerDependencies {
  if (dependencies) return dependencies;
  const env = serverEnv();
  const cache = createCacheStore(env);
  dependencies = {
    cache,
    limiter: new RateLimiter(cache),
    async authenticate(request) {
      const user = await verifyUser(env, request);
      return {
        userId: user.id,
        repository: createSupabaseCloudSaveRepository(createUserScopedClient(env, user.token)),
      };
    },
  };
  return dependencies;
}

export async function saveCollectionHandler(request: Request): Promise<Response> {
  try {
    return await createSaveCollectionHandler(runtimeDependencies())(request);
  } catch (error) {
    return safeHandlerError(error, requestId(request));
  }
}

export async function saveItemHandler(request: Request, slot: string): Promise<Response> {
  try {
    return await createSaveItemHandler(runtimeDependencies(), slot)(request);
  } catch (error) {
    return safeHandlerError(error, requestId(request));
  }
}
