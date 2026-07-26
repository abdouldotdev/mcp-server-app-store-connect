/**
 * Process-wide logger.
 *
 * CRITICAL: in stdio transport mode, stdout is the MCP protocol channel.
 * Writing anything that is not a JSON-RPC frame to stdout corrupts the
 * protocol and the client disconnects. Therefore EVERY log line — including
 * plain informational output — is written to stderr.
 *
 * Never use `console.log` anywhere in this codebase. Use this logger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') {
    return raw;
  }
  return 'info';
}

const currentLevel = resolveLevel();

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  if (currentLevel === 'silent') return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel as Exclude<LogLevel, 'silent'>];
}

function emit(level: Exclude<LogLevel, 'silent'>, args: unknown[]): void {
  if (!enabled(level)) return;
  // Always stderr — see file header.
  console.error(`[${level}]`, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};

/**
 * Redact a secret so it can be mentioned in a log without leaking it.
 * Returns only a presence marker and a length — never any part of the value.
 */
export function redacted(value: string | undefined | null): string {
  if (!value) return '<missing>';
  return `<set:${value.length} chars>`;
}
