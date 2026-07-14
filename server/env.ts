import { HttpError } from './http.js';

export interface ServerEnv {
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string | null;
  redisUrl: string | null;
}

function required(source: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = source[name] || (fallback ? source[fallback] : undefined);
  if (!value) throw new HttpError(503, 'CONFIG_UNAVAILABLE', 'Cloud services are not configured');
  return value;
}

export function serverEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return {
    supabaseUrl: required(source, 'SUPABASE_URL'),
    supabasePublishableKey: required(source, 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: source.SUPABASE_SERVICE_ROLE_KEY || source.SUPABASE_SECRET_KEY || null,
    redisUrl: source.REDIS_URL || null,
  };
}
