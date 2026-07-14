import * as Sentry from '@sentry/browser';
import { inject, track } from '@vercel/analytics';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { safeAnalyticsProperties, scrubSentryEvent, stripQuery, type TelemetryEventName } from './privacy';

export class TelemetryService {
  private enabled = true;
  private vercelInjected = false;
  private sentryStarted = false;

  start(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.ensureStarted();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.ensureStarted();
    else if (this.sentryStarted) {
      this.sentryStarted = false;
      void Sentry.close(1_000);
    }
  }

  setUser(userId: string | null): void {
    if (!this.sentryStarted) return;
    Sentry.setUser(userId ? { id: userId } : null);
  }

  track(name: TelemetryEventName, properties: Readonly<Record<string, unknown>> = {}): void {
    if (!this.enabled) return;
    track(name, safeAnalyticsProperties(name, properties));
  }

  captureError(error: unknown): void {
    if (!this.enabled || !this.sentryStarted) return;
    Sentry.captureException(error);
  }

  private ensureStarted(): void {
    if (!this.vercelInjected && __VERCEL_DEPLOYED__) {
      this.vercelInjected = true;
      inject({
        mode: import.meta.env.PROD ? 'production' : 'development',
        beforeSend: (event) => this.enabled ? { ...event, url: stripQuery(event.url) } : null,
      });
      injectSpeedInsights({
        sampleRate: 1,
        beforeSend: (event) => this.enabled ? { ...event, url: stripQuery(event.url) } : null,
      });
    }
    if (!this.sentryStarted && __SENTRY_DSN__) {
      this.sentryStarted = true;
      Sentry.init({
        dsn: __SENTRY_DSN__,
        release: __PERILUNE_RELEASE__,
        environment: import.meta.env.MODE,
        sendDefaultPii: false,
        tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
        integrations: import.meta.env.PROD ? [Sentry.browserTracingIntegration()] : [],
        beforeSend: (event) => this.enabled ? scrubSentryEvent(event) : null,
      });
    }
  }
}

export const telemetry = new TelemetryService();
