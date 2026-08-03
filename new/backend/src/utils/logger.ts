import winston from 'winston';
import path from 'path';
import fs from 'fs';

const logDir = process.env.LOG_DIR || './logs';

// สร้างโฟลเดอร์ logs ถ้ายังไม่มี
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, worker, ...meta }) => {
    const workerTag = worker ? ` [W${worker}]` : '';
    const metaStr =
      Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)}${workerTag} ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    // Console — สีสัน
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        logFormat
      ),
    }),
    // ไฟล์รวม
    new winston.transports.File({
      filename: path.join(logDir, 'clipbot.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    // ไฟล์ error เท่านั้น
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticEvent = {
  source: 'service' | 'extension' | 'flow' | 'gemini' | 'ffmpeg' | 'database' | string;
  stage: string;
  message: string;
  level?: DiagnosticLevel;
  jobId?: number | null;
  clipIndex?: number | null;
  traceId?: string;
  durationMs?: number;
  error?: unknown;
  meta?: Record<string, unknown>;
};

const secretKeyPattern = /(api[-_ ]?key|authorization|cookie|token|secret|password)/i;

/** Remove credentials and cap large values before diagnostics reach disk. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[max-depth]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split('\n').slice(0, 12).join('\n'),
    };
  }
  if (Buffer.isBuffer(value)) return `[buffer:${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        secretKeyPattern.test(key) ? '[redacted]' : sanitize(entry, depth + 1),
      ])
    );
  }
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  return value;
}

/**
 * Durable machine-readable event log. One JSON object per line makes it easy to
 * filter a single job/clip without losing the human-readable Winston log.
 */
export function logEvent(event: DiagnosticEvent): void {
  const at = new Date().toISOString();
  const level = event.level || 'info';
  const record = sanitize({ at, ...event, level }) as Record<string, unknown>;
  const date = at.slice(0, 10);
  try {
    fs.appendFileSync(path.join(logDir, `events-${date}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    // A full/locked log disk must not turn a successful bot step into a failure.
    console.error('[ClipBot] เขียน diagnostic event ไม่สำเร็จ', error);
  }

  const context = [
    event.source,
    event.stage,
    event.traceId ? `trace=${event.traceId}` : '',
    event.jobId != null ? `job=${event.jobId}` : '',
    event.clipIndex != null ? `clip=${event.clipIndex + 1}` : '',
  ].filter(Boolean).join(' | ');
  logger.log(level, `[${context}] ${event.message}`, {
    durationMs: event.durationMs,
    error: sanitize(event.error),
    ...sanitize(event.meta || {}) as Record<string, unknown>,
  });
}

export async function traceStep<T>(event: Omit<DiagnosticEvent, 'durationMs' | 'error'>, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  logEvent({ ...event, message: `${event.message} — เริ่ม`, level: 'info' });
  try {
    const result = await action();
    logEvent({ ...event, message: `${event.message} — สำเร็จ`, level: 'info', durationMs: Date.now() - started });
    return result;
  } catch (error) {
    logEvent({ ...event, message: `${event.message} — ล้มเหลว`, level: 'error', durationMs: Date.now() - started, error });
    throw error;
  }
}
