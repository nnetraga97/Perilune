export interface CloudPublicConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export function cloudPublicConfig(): CloudPublicConfig | null {
  if (!__SUPABASE_URL__ || !__SUPABASE_PUBLISHABLE_KEY__) return null;
  return {
    supabaseUrl: __SUPABASE_URL__,
    supabasePublishableKey: __SUPABASE_PUBLISHABLE_KEY__,
  };
}
