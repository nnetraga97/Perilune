import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cloudPublicConfig } from './config';

export interface AuthSession {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'guest' }
  | { kind: 'signed-in'; session: AuthSession }
  | { kind: 'unavailable'; message: string };

interface AuthResponse {
  ok: boolean;
  data?: {
    session: { accessToken: string; refreshToken: string; expiresAt: number | null };
    user: { id: string; email: string };
  };
  error?: { code: string; message: string };
}

type Listener = (state: AuthState) => void;

function mapSession(session: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>['data']['session']): AuthSession | null {
  if (!session?.user.email) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

export class AuthService {
  private readonly client: SupabaseClient | null;
  private stateValue: AuthState;
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    client?: SupabaseClient | null,
  ) {
    const config = cloudPublicConfig();
    this.client = client === undefined
      ? config
        ? createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        })
        : null
      : client;
    this.stateValue = this.client
      ? { kind: 'loading' }
      : { kind: 'unavailable', message: 'Cloud accounts are unavailable in this build.' };
  }

  get state(): AuthState {
    return this.stateValue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<AuthState> {
    if (!this.client) return this.stateValue;
    const { data, error } = await this.client.auth.getSession();
    this.publish(error ? { kind: 'guest' } : this.stateFor(data.session));
    const { data: subscription } = this.client.auth.onAuthStateChange((_event, session) => {
      this.publish(this.stateFor(session));
    });
    this.unsubscribe?.();
    this.unsubscribe = () => subscription.subscription.unsubscribe();
    return this.stateValue;
  }

  async signUp(email: string, password: string): Promise<void> {
    await this.authenticate('signup', email, password);
  }

  async signIn(email: string, password: string): Promise<void> {
    await this.authenticate('login', email, password);
  }

  async signOut(): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw new Error('Sign out failed. Try again.');
    this.publish({ kind: 'guest' });
  }

  async accessToken(refresh = false): Promise<string | null> {
    if (!this.client) return null;
    const result = refresh ? await this.client.auth.refreshSession() : await this.client.auth.getSession();
    if (result.error) {
      this.publish({ kind: 'guest' });
      return null;
    }
    const mapped = mapSession(result.data.session);
    if (mapped) this.publish({ kind: 'signed-in', session: mapped });
    return mapped?.accessToken ?? null;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  private async authenticate(mode: 'signup' | 'login', email: string, password: string): Promise<void> {
    if (!this.client) throw new Error('Cloud accounts are unavailable in this build.');
    const response = await this.fetcher(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json() as AuthResponse;
    if (!response.ok || !body.ok || !body.data) {
      throw new Error(body.error?.message ?? 'Account request failed. Try again.');
    }
    const result = await this.client.auth.setSession({
      access_token: body.data.session.accessToken,
      refresh_token: body.data.session.refreshToken,
    });
    if (result.error || !result.data.session) throw new Error('The account session could not be started.');
    this.publish(this.stateFor(result.data.session));
  }

  private stateFor(session: Parameters<Parameters<SupabaseClient['auth']['onAuthStateChange']>[0]>[1]): AuthState {
    const mapped = mapSession(session);
    return mapped ? { kind: 'signed-in', session: mapped } : { kind: 'guest' };
  }

  private publish(state: AuthState): void {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}
