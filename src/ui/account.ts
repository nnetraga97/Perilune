import type { AuthService, AuthState } from '../cloud/auth';
import { el } from './kit';
import type { WindowManager } from './window';
import { telemetry } from '../telemetry/service';

export class AccountWindow {
  private content: HTMLElement | null = null;
  private busy = false;
  private error = '';

  constructor(
    private readonly windows: WindowManager,
    private readonly auth: AuthService,
  ) {
    windows.register({
      id: 'account', title: 'ACCOUNT', launcherIcon: 'account', buttonLabel: 'Account', screen: 'any',
      defaultPos: { x: 540, y: 110 },
      build: (content) => { this.content = content; this.render(auth.state); },
    });
    auth.subscribe((state) => this.render(state));
  }

  open(): void {
    this.windows.toggle('account');
  }

  private render(state: AuthState): void {
    if (!this.content) return;
    this.content.replaceChildren();
    if (state.kind === 'loading') {
      el('div', 'utility-muted', this.content, 'Restoring your account session…');
      return;
    }
    if (state.kind === 'unavailable') {
      el('div', 'mission-empty', this.content, state.message);
      return;
    }
    if (state.kind === 'signed-in') {
      el('div', 'utility-heading', this.content, 'SIGNED IN');
      el('div', 'account-email', this.content, state.session.email);
      el('div', 'utility-muted', this.content, 'Cloud saves sync while this account is active. Local saves remain after sign out.');
      const signOut = el('button', 'hud-btn account-submit', this.content, this.busy ? 'Signing out…' : 'Sign out') as HTMLButtonElement;
      signOut.disabled = this.busy;
      signOut.onclick = () => void this.submit(async () => {
        await this.auth.signOut();
        telemetry.setUser(null);
        telemetry.track('signed_out');
      });
      this.renderError();
      return;
    }
    el('div', 'utility-muted', this.content, 'Play as a guest or sign in to sync saves between devices.');
    this.renderForm('SIGN IN', 'login');
    this.renderForm('CREATE ACCOUNT', 'signup');
    this.renderError();
  }

  private renderForm(title: string, mode: 'login' | 'signup'): void {
    const form = el('form', 'account-form', this.content!);
    el('div', 'mission-section-title', form, title);
    const email = document.createElement('input');
    email.className = 'k-input'; email.type = 'email'; email.required = true;
    email.placeholder = 'Email'; email.autocomplete = 'email'; email.maxLength = 320;
    form.appendChild(email);
    const password = document.createElement('input');
    password.className = 'k-input'; password.type = 'password'; password.required = true;
    password.placeholder = 'Password (8+ characters)'; password.minLength = 8; password.maxLength = 256;
    password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    form.appendChild(password);
    const submit = el('button', 'hud-btn account-submit', form, mode === 'signup' ? 'Create account' : 'Sign in') as HTMLButtonElement;
    submit.type = 'submit'; submit.disabled = this.busy;
    form.onsubmit = (event) => {
      event.preventDefault();
      void this.submit(async () => {
        if (mode === 'signup') {
          await this.auth.signUp(email.value, password.value);
          telemetry.track('account_created');
        } else {
          await this.auth.signIn(email.value, password.value);
          telemetry.track('signed_in');
        }
      });
    };
  }

  private renderError(): void {
    if (!this.content) return;
    const error = el('div', this.error ? 'account-error' : 'account-error account-error-empty', this.content, this.error);
    error.setAttribute('aria-live', 'polite');
  }

  private async submit(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.render(this.auth.state);
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Account request failed.';
    } finally {
      this.busy = false;
      this.render(this.auth.state);
    }
  }
}
