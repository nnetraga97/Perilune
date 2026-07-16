import {
  errorFields,
  sanitizeChildFields,
  sanitizeLogFields,
  type LogEvent,
  type LogFields,
  type LogLevel,
  type LogValue,
} from './logContract';
import { telemetry } from './service';

export interface BrowserLogger {
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, error: unknown, fields?: LogFields): void;
  with(fields: LogFields): BrowserLogger;
}

class ClientLogger implements BrowserLogger {
  constructor(private readonly childFields: Record<string, LogValue> = {}) {}

  debug(event: LogEvent, fields?: LogFields): void { this.emit('debug', event, fields); }
  info(event: LogEvent, fields?: LogFields): void { this.emit('info', event, fields); }
  warn(event: LogEvent, fields?: LogFields): void { this.emit('warn', event, fields); }

  error(event: LogEvent, error: unknown, fields?: LogFields): void {
    this.emit('error', event, { ...fields, ...errorFields(error) });
    telemetry.captureError(error);
  }

  with(fields: LogFields): BrowserLogger {
    return new ClientLogger({ ...this.childFields, ...sanitizeChildFields(fields) });
  }

  private emit(level: LogLevel, event: LogEvent, fields?: LogFields): void {
    if (!telemetry.isEnabled()) return;
    const safeFields = { ...sanitizeLogFields(event, fields), ...this.childFields };
    telemetry.addBreadcrumb(event, safeFields);
    if (!import.meta.env.DEV) return;
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.info;
    method(`[${event}]`, safeFields);
  }
}

export const clientLog: BrowserLogger = new ClientLogger();
