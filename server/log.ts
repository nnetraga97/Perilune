import {
  errorFields,
  sanitizeChildFields,
  sanitizeLogFields,
  type LogEvent,
  type LogFields,
  type LogLevel,
  type LogValue,
} from '../src/telemetry/logContract.js';
import { captureServerError, flushServerTelemetry } from './sentry.js';

export interface Logger {
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, error: unknown, fields?: LogFields): void;
  with(fields: LogFields): Logger;
}

type Envelope = Record<string, LogValue> & {
  level: LogLevel;
  ts: string;
  event: LogEvent;
};

class ServerLogger implements Logger {
  constructor(private readonly childFields: Record<string, LogValue> = {}) {}

  debug(event: LogEvent, fields?: LogFields): void { this.emit('debug', event, fields); }
  info(event: LogEvent, fields?: LogFields): void { this.emit('info', event, fields); }
  warn(event: LogEvent, fields?: LogFields): void { this.emit('warn', event, fields); }

  error(event: LogEvent, error: unknown, fields?: LogFields): void {
    const merged: Record<string, LogValue> = { ...fields, ...errorFields(error) };
    this.emit('error', event, merged);
    captureServerError(error, {
      requestId: typeof this.childFields.requestId === 'string' ? this.childFields.requestId : undefined,
      event,
      operation: typeof merged.operation === 'string' ? merged.operation : undefined,
      dependency: merged.dependency === 'redis' || merged.dependency === 'supabase' ? merged.dependency : undefined,
    });
  }

  with(fields: LogFields): Logger {
    return new ServerLogger({ ...this.childFields, ...sanitizeChildFields(fields) });
  }

  private emit(level: LogLevel, event: LogEvent, fields?: LogFields): void {
    const envelope: Envelope = {
      level,
      ts: new Date().toISOString(),
      event,
      ...sanitizeLogFields(event, fields),
      ...this.childFields,
    };
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.info;
    if (process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') method(JSON.stringify(envelope));
    else method(`[${event}]`, envelope);
  }
}

export const log: Logger = new ServerLogger();
export { flushServerTelemetry };
