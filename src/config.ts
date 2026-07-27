/**
 * Environment configuration loading and validation.
 *
 * No secret value (private key, Key ID, Issuer ID) is ever logged, not even
 * partially. Only presence markers are reported.
 */

import { logger, redacted } from './logger.js';
import type { AppStoreConfig } from './appstore-client.js';

export type TransportMode = 'stdio' | 'http';

const REQUIRED_ENV_VARS = [
  'APPLE_KEY_ID',
  'APPLE_ISSUER_ID',
  'APPLE_PRIVATE_KEY',
  'APPLE_BUNDLE_ID',
] as const;

/**
 * Normalize the private key: it may be provided as raw PEM, as PEM with
 * escaped newlines, or base64-encoded (common when stored in a secret manager).
 */
function normalizePrivateKey(raw: string): string {
  const value = raw.trim();
  if (!value) return '';

  if (value.includes('BEGIN PRIVATE KEY')) {
    return value.replace(/\\n/g, '\n').trim();
  }

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8').trim();
    if (decoded.includes('BEGIN PRIVATE KEY')) {
      return decoded;
    }
  } catch {
    // Not base64 — fall through.
  }

  return value.replace(/\\n/g, '\n').trim();
}

export function getAppStoreConfig(): AppStoreConfig {
  const privateKey = normalizePrivateKey(process.env.APPLE_PRIVATE_KEY || '');

  const config: AppStoreConfig = {
    keyId: (process.env.APPLE_KEY_ID || '').trim(),
    issuerId: (process.env.APPLE_ISSUER_ID || '').trim(),
    privateKey,
    bundleId: (process.env.APPLE_BUNDLE_ID || '').trim(),
    vendorNumber: process.env.APPLE_VENDOR_NUMBER?.trim(),
  };

  logger.debug('App Store Connect credentials loaded:', {
    keyId: redacted(config.keyId),
    issuerId: redacted(config.issuerId),
    privateKey: redacted(config.privateKey),
    bundleId: config.bundleId ? 'set' : 'missing',
  });

  return config;
}

/**
 * Fail fast when credentials are missing. Reports names only, never values.
 */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

/**
 * stdio is the default transport. HTTP only starts when explicitly requested.
 */
export function getTransportMode(): TransportMode {
  const raw = (process.env.TRANSPORT || '').trim().toLowerCase();
  if (raw === 'http') return 'http';
  if (raw && raw !== 'stdio') {
    logger.warn(`Unknown TRANSPORT="${raw}", falling back to stdio.`);
  }
  return 'stdio';
}
