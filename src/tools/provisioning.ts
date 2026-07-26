/**
 * Tools for code-signing assets: certificates, bundle IDs (and their
 * capabilities), registered devices and provisioning profiles.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED API KEY ROLE
 * ---------------------------------------------------------------------------
 * Every endpoint used here lives under the "Certificates, Identifiers &
 * Profiles" part of App Store Connect, which Apple gates behind the **Admin**
 * or **Developer** role. An API key limited to "App Manager" and/or "Sales and
 * Reports" gets a bare HTTP 403 with no explanation. `withProvisioningAccess`
 * below turns that into an actionable message instead of a raw Apple error.
 *
 * ---------------------------------------------------------------------------
 * BINARY PAYLOADS
 * ---------------------------------------------------------------------------
 * Certificates (`certificateContent`) and profiles (`profileContent`) come back
 * base64-encoded and are several kilobytes long. Dumping them into the
 * conversation is useless and expensive, so they are never printed: tools take
 * an optional `outputPath` and write the decoded bytes there instead.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import { AppStoreApiError, type AppStoreClient } from '../appstore-client.js';
import { defineTool, type Tool } from './types.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Default window used to flag "about to expire" certificates and profiles. */
const DEFAULT_WARNING_DAYS = 30;

/** Page size used for the collection endpoints (Apple's maximum is 200). */
const PAGE_LIMIT = 200;

const CERTIFICATE_TYPES = [
  'IOS_DEVELOPMENT',
  'IOS_DISTRIBUTION',
  'DEVELOPMENT',
  'DISTRIBUTION',
  'MAC_APP_DISTRIBUTION',
  'MAC_INSTALLER_DISTRIBUTION',
  'MAC_APP_DEVELOPMENT',
  'DEVELOPER_ID_KEXT',
  'DEVELOPER_ID_APPLICATION',
  'PASS_TYPE_ID',
  'PASS_TYPE_ID_WITH_NFC',
] as const;

const PROFILE_TYPES = [
  'IOS_APP_DEVELOPMENT',
  'IOS_APP_STORE',
  'IOS_APP_ADHOC',
  'IOS_APP_INHOUSE',
  'MAC_APP_DEVELOPMENT',
  'MAC_APP_STORE',
  'MAC_APP_DIRECT',
  'TVOS_APP_DEVELOPMENT',
  'TVOS_APP_STORE',
  'TVOS_APP_ADHOC',
  'TVOS_APP_INHOUSE',
  'MAC_CATALYST_APP_DEVELOPMENT',
  'MAC_CATALYST_APP_STORE',
  'MAC_CATALYST_APP_DIRECT',
] as const;

const BUNDLE_ID_PLATFORMS = ['IOS', 'MAC_OS', 'UNIVERSAL'] as const;

const DEVICE_PLATFORMS = ['IOS', 'MAC_OS'] as const;

/**
 * Capability identifiers accepted by `/v1/bundleIdCapabilities`.
 * Documented here because the endpoint rejects anything else with an opaque
 * validation error, and Apple's console uses entirely different labels.
 */
const CAPABILITY_TYPES = [
  'ACCESS_WIFI_INFORMATION',
  'APPLE_ID_AUTH', // "Sign in with Apple"
  'APP_ATTEST',
  'APP_GROUPS',
  'ASSOCIATED_DOMAINS',
  'AUTOFILL_CREDENTIAL_PROVIDER',
  'CLASSKIT',
  'COREMEDIA_HLS_LOW_LATENCY',
  'DATA_PROTECTION',
  'FAMILY_CONTROLS',
  'FILEPROVIDER_TESTINGMODE',
  'GAME_CENTER',
  'GROUP_ACTIVITIES',
  'HEALTHKIT',
  'HOMEKIT',
  'HOT_SPOT',
  'ICLOUD',
  'IN_APP_PURCHASE',
  'INTER_APP_AUDIO',
  'MAPS',
  'MARZIPAN', // Mac Catalyst
  'MULTIPATH',
  'NETWORK_CUSTOM_PROTOCOL',
  'NETWORK_EXTENSIONS',
  'NFC_TAG_READING',
  'PERSONAL_VPN',
  'PUSH_NOTIFICATIONS',
  'SIRIKIT',
  'SYSTEM_EXTENSION_INSTALL',
  'USER_MANAGEMENT',
  'WALLET',
  'WEATHERKIT',
  'WIRELESS_ACCESSORY_CONFIGURATION',
] as const;

/**
 * Capabilities that also need a `settings` array. Passing them without one is
 * the most common cause of a 409 from this endpoint.
 */
const CAPABILITIES_REQUIRING_SETTINGS =
  'ICLOUD (ICLOUD_VERSION), DATA_PROTECTION (DATA_PROTECTION_PERMISSION_LEVEL), APPLE_ID_AUTH (APPLE_ID_AUTH_APP_CONSENT)';

// ---------------------------------------------------------------------------
// Role-aware error handling
// ---------------------------------------------------------------------------

const ROLE_HINT =
  'This operation requires an App Store Connect API key with the Admin or Developer role. ' +
  'A key restricted to "App Manager" and/or "Sales and Reports" cannot read or modify ' +
  'certificates, identifiers, devices or provisioning profiles. ' +
  'Create a new key under Users and Access › Integrations › App Store Connect API with the ' +
  'Developer role (read + create) or Admin (also allows revoking).';

/**
 * Run an App Store Connect call and translate authorisation failures into a
 * message that says what to do about them.
 *
 * Only 401/403 are rewritten, and Apple's own `detail` string is kept in the
 * message — every other failure is re-thrown untouched so the `AppStoreApiError`
 * message survives intact.
 */
async function withProvisioningAccess<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppStoreApiError && (error.httpStatus === 403 || error.httpStatus === 401)) {
      throw new Error(
        `${operation} was refused by App Store Connect (HTTP ${error.httpStatus}).\n\n` +
          `${ROLE_HINT}\n\nApple's response: ${error.message}`
      );
    }
    throw error;
  }
}

/** True when a failure is the "your key lacks the role" case. */
function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof AppStoreApiError && (error.httpStatus === 403 || error.httpStatus === 401)
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function formatDate(iso?: string | null): string {
  if (!iso) return 'unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Whole days from now until `iso`. Negative when already past. */
function daysUntil(iso?: string | null): number | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor((date.getTime() - Date.now()) / MS_PER_DAY);
}

type ExpiryLevel = 'expired' | 'expiring' | 'ok' | 'unknown';

function expiryLevel(iso: string | undefined, warningDays: number): ExpiryLevel {
  const days = daysUntil(iso);
  if (days === undefined) return 'unknown';
  if (days < 0) return 'expired';
  if (days <= warningDays) return 'expiring';
  return 'ok';
}

/** One-line human summary of an expiration date, prefixed with a status marker. */
function expiryLabel(iso: string | undefined, warningDays: number): string {
  const days = daysUntil(iso);
  if (days === undefined) return 'no expiration date reported';

  const when = formatDate(iso);
  if (days < 0) return `EXPIRED ${Math.abs(days)} day(s) ago, on ${when}`;
  if (days === 0) return `EXPIRES TODAY (${when})`;
  if (days <= warningDays) return `EXPIRES SOON — in ${days} day(s), on ${when}`;
  return `valid for ${days} more day(s), until ${when}`;
}

function statusMarker(level: ExpiryLevel): string {
  switch (level) {
    case 'expired':
      return '[EXPIRED]';
    case 'expiring':
      return '[EXPIRING]';
    case 'unknown':
      return '[UNKNOWN]';
    default:
      return '[OK]';
  }
}

/** Sort helper: soonest expiration first, unknown dates last. */
function byExpiration(a?: string, b?: string): number {
  const aTime = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
  const bTime = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
  return aTime - bTime;
}

// ---------------------------------------------------------------------------
// File output helper
// ---------------------------------------------------------------------------

/**
 * Decode a base64 payload to `outputPath`.
 *
 * Only ever called with a path the user typed themselves — nothing is written
 * to an implicit or derived location.
 */
async function writeBase64File(outputPath: string, base64: string): Promise<string> {
  const target = resolvePath(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(base64, 'base64'));
  return target;
}

/**
 * Describe a base64 blob without printing it: either the file it was written
 * to, or an invitation to pass `outputPath`.
 */
async function describeBinaryPayload(params: {
  base64?: string;
  outputPath?: string;
  suggestedName: string;
  kind: string;
}): Promise<string> {
  if (!params.base64) return `No ${params.kind} content returned by Apple.`;

  const bytes = Buffer.from(params.base64, 'base64').length;

  if (!params.outputPath) {
    return (
      `${params.kind} content: ${bytes} bytes (base64, not printed here). ` +
      `Re-run with outputPath (e.g. "./${params.suggestedName}") to save it to disk.`
    );
  }

  const written = await writeBase64File(params.outputPath, params.base64);
  return `${params.kind} written to ${written} (${bytes} bytes).`;
}

// ---------------------------------------------------------------------------
// Fetch helpers shared by the listing tools and the health check
// ---------------------------------------------------------------------------

interface CertificateRecord {
  id: string;
  name: string;
  displayName?: string;
  certificateType?: string;
  platform?: string;
  serialNumber?: string;
  expirationDate?: string;
}

interface ProfileRecord {
  id: string;
  name: string;
  profileType?: string;
  profileState?: string;
  platform?: string;
  uuid?: string;
  expirationDate?: string;
  certificateIds: string[];
  deviceCount: number;
  bundleIdRef?: string;
}

async function fetchCertificates(
  client: AppStoreClient,
  certificateType?: string
): Promise<CertificateRecord[]> {
  const { data } = await client.getAllPages('/v1/certificates', {
    query: {
      limit: PAGE_LIMIT,
      'filter[certificateType]': certificateType,
    },
  });

  return data.map((cert: any) => ({
    id: cert.id,
    name: cert.attributes?.name ?? '(unnamed)',
    displayName: cert.attributes?.displayName,
    certificateType: cert.attributes?.certificateType,
    platform: cert.attributes?.platform,
    serialNumber: cert.attributes?.serialNumber,
    expirationDate: cert.attributes?.expirationDate,
  }));
}

async function fetchProfiles(
  client: AppStoreClient,
  profileType?: string
): Promise<ProfileRecord[]> {
  // `certificates` is requested as a relationship only (no `include`) so the
  // response stays small: the health check just needs the certificate IDs.
  const { data } = await client.getAllPages('/v1/profiles', {
    query: {
      limit: PAGE_LIMIT,
      'filter[profileType]': profileType,
      include: 'certificates',
      'fields[certificates]': 'id',
      'limit[certificates]': 50,
    },
  });

  return data.map((profile: any) => ({
    id: profile.id,
    name: profile.attributes?.name ?? '(unnamed)',
    profileType: profile.attributes?.profileType,
    profileState: profile.attributes?.profileState,
    platform: profile.attributes?.platform,
    uuid: profile.attributes?.uuid,
    expirationDate: profile.attributes?.expirationDate,
    certificateIds: (profile.relationships?.certificates?.data ?? []).map((ref: any) => ref.id),
    deviceCount: (profile.relationships?.devices?.data ?? []).length,
    bundleIdRef: profile.relationships?.bundleId?.data?.id,
  }));
}

// ---------------------------------------------------------------------------
// 1. Certificates
// ---------------------------------------------------------------------------

export const listCertificates = defineTool<{
  certificateType?: string;
  warningDays?: number;
  onlyProblems?: boolean;
}>({
  name: 'list_signing_certificates',
  description:
    'List App Store Connect signing certificates with their expiration dates, flagging the ones that are expired or expiring soon. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      certificateType: {
        type: 'string',
        enum: [...CERTIFICATE_TYPES],
        description: 'Optional filter on the certificate type.',
      },
      warningDays: {
        type: 'number',
        description: `Days ahead used to flag a certificate as expiring soon (default ${DEFAULT_WARNING_DAYS}).`,
      },
      onlyProblems: {
        type: 'boolean',
        description: 'When true, only return expired or soon-to-expire certificates.',
      },
    },
  },
  handler: async ({ certificateType, warningDays, onlyProblems }, client) => {
    const window = warningDays ?? DEFAULT_WARNING_DAYS;

    const certificates = await withProvisioningAccess('Listing certificates', () =>
      fetchCertificates(client, certificateType)
    );

    if (certificates.length === 0) {
      return certificateType
        ? `No certificates of type ${certificateType} found.`
        : 'No certificates found on this account.';
    }

    const sorted = [...certificates].sort((a, b) => byExpiration(a.expirationDate, b.expirationDate));
    const rows = sorted
      .map((cert) => ({ cert, level: expiryLevel(cert.expirationDate, window) }))
      .filter(({ level }) => (onlyProblems ? level === 'expired' || level === 'expiring' : true));

    if (rows.length === 0) {
      return `All ${certificates.length} certificate(s) are valid for more than ${window} day(s).`;
    }

    const expired = rows.filter((r) => r.level === 'expired').length;
    const expiring = rows.filter((r) => r.level === 'expiring').length;

    const header =
      `Certificates (${certificates.length} total` +
      `${expired ? `, ${expired} expired` : ''}` +
      `${expiring ? `, ${expiring} expiring within ${window} day(s)` : ''}):`;

    const body = rows
      .map(({ cert, level }) => {
        const label = cert.displayName || cert.name;
        return [
          `${statusMarker(level)} ${label}`,
          `   • Type: ${cert.certificateType ?? 'unknown'}${cert.platform ? ` (${cert.platform})` : ''}`,
          `   • ${expiryLabel(cert.expirationDate, window)}`,
          `   • Serial: ${cert.serialNumber ?? 'n/a'}`,
          `   • Certificate ID: ${cert.id}`,
        ].join('\n');
      })
      .join('\n\n');

    return `${header}\n\n${body}`;
  },
});

export const getCertificate = defineTool<{ certificateId: string; outputPath?: string }>({
  name: 'get_signing_certificate',
  description:
    'Get one signing certificate (type, expiration, serial) and optionally save its .cer file locally instead of printing base64. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      certificateId: { type: 'string', description: 'The certificate resource ID.' },
      outputPath: {
        type: 'string',
        description:
          'Optional local file path where the DER-encoded certificate is written (e.g. "./distribution.cer"). Omit to skip writing.',
      },
    },
    required: ['certificateId'],
  },
  handler: async ({ certificateId, outputPath }, client) => {
    const response = await withProvisioningAccess('Reading a certificate', () =>
      client.get(`/v1/certificates/${certificateId}`)
    );

    const attributes = response?.data?.attributes ?? {};
    const fileNote = await describeBinaryPayload({
      base64: attributes.certificateContent,
      outputPath,
      suggestedName: `${attributes.name || 'certificate'}.cer`,
      kind: 'Certificate',
    });

    return [
      `Certificate: ${attributes.displayName || attributes.name || certificateId}`,
      `• Type: ${attributes.certificateType ?? 'unknown'}`,
      `• Platform: ${attributes.platform ?? 'n/a'}`,
      `• ${expiryLabel(attributes.expirationDate, DEFAULT_WARNING_DAYS)}`,
      `• Serial: ${attributes.serialNumber ?? 'n/a'}`,
      `• Certificate ID: ${certificateId}`,
      '',
      fileNote,
    ].join('\n');
  },
});

export const createCertificate = defineTool<{
  certificateType: string;
  csrContent: string;
  outputPath?: string;
}>({
  name: 'create_signing_certificate',
  description:
    'Create a signing certificate from a base64 CSR and optionally save the issued .cer locally. Distribution certificates are limited in number by Apple. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      certificateType: {
        type: 'string',
        enum: [...CERTIFICATE_TYPES],
        description: 'Type of certificate to issue.',
      },
      csrContent: {
        type: 'string',
        description:
          'The Certificate Signing Request, base64-encoded. Either the raw base64 body or the full PEM ("-----BEGIN CERTIFICATE REQUEST-----...") is accepted.',
      },
      outputPath: {
        type: 'string',
        description:
          'Optional local file path for the issued certificate (e.g. "./distribution.cer"). Recommended: the certificate is otherwise only returned as base64 and not printed.',
      },
    },
    required: ['certificateType', 'csrContent'],
  },
  handler: async ({ certificateType, csrContent, outputPath }, client) => {
    // Apple accepts the PEM armour, but stray whitespace from a copy/paste is a
    // frequent cause of a validation error — normalise line endings only.
    const csr = csrContent.trim();

    const response = await withProvisioningAccess('Creating a certificate', () =>
      client.post('/v1/certificates', {
        data: {
          type: 'certificates',
          attributes: { certificateType, csrContent: csr },
        },
      })
    );

    const created = response?.data;
    const attributes = created?.attributes ?? {};

    const fileNote = await describeBinaryPayload({
      base64: attributes.certificateContent,
      outputPath,
      suggestedName: `${attributes.name || 'certificate'}.cer`,
      kind: 'Certificate',
    });

    return [
      `Created certificate ${attributes.displayName || attributes.name || created?.id}.`,
      `• Type: ${attributes.certificateType ?? certificateType}`,
      `• ${expiryLabel(attributes.expirationDate, DEFAULT_WARNING_DAYS)}`,
      `• Serial: ${attributes.serialNumber ?? 'n/a'}`,
      `• Certificate ID: ${created?.id ?? 'unknown'}`,
      '',
      fileNote,
    ].join('\n');
  },
});

export const revokeCertificate = defineTool<{ certificateId: string; confirm?: boolean }>({
  name: 'revoke_signing_certificate',
  description:
    'DESTRUCTIVE: permanently revoke a signing certificate. Revoking a distribution certificate invalidates every provisioning profile built on it and breaks the signature of builds still being distributed. Requires confirm:true and an API key with the Admin role.',
  inputSchema: {
    type: 'object',
    properties: {
      certificateId: { type: 'string', description: 'The certificate resource ID to revoke.' },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Revocation cannot be undone: the certificate is gone and profiles referencing it become INVALID.',
      },
    },
    required: ['certificateId'],
  },
  handler: async ({ certificateId, confirm }, client) => {
    if (confirm !== true) {
      return (
        `Refusing to revoke certificate ${certificateId}: confirm was not set to true.\n\n` +
        'Revoking is irreversible. Every provisioning profile signed with this certificate ' +
        'becomes INVALID, and builds in review or in distribution that rely on it break. ' +
        'Re-run with confirm: true only if that is what you intend.'
      );
    }

    // Read it first so the confirmation message names what was destroyed.
    let label = certificateId;
    try {
      const existing = await client.get(`/v1/certificates/${certificateId}`);
      const attributes = existing?.data?.attributes ?? {};
      label = `${attributes.displayName || attributes.name || certificateId} (${attributes.certificateType ?? 'unknown type'})`;
    } catch (error) {
      if (isAccessDenied(error)) throw error; // surfaced by the call below with the role hint
      // Any other lookup failure is not a reason to abort the revocation.
    }

    await withProvisioningAccess('Revoking a certificate', () =>
      client.delete(`/v1/certificates/${certificateId}`)
    );

    return (
      `Revoked certificate ${label}.\n` +
      'Provisioning profiles that referenced it are now INVALID — regenerate them before the next build.'
    );
  },
});

// ---------------------------------------------------------------------------
// 2. Bundle IDs
// ---------------------------------------------------------------------------

export const listBundleIds = defineTool<{ identifier?: string; platform?: string }>({
  name: 'list_bundle_ids',
  description:
    'List the bundle IDs (identifiers) registered on the developer account. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Optional exact bundle identifier filter, e.g. "com.example.app".',
      },
      platform: {
        type: 'string',
        enum: [...BUNDLE_ID_PLATFORMS],
        description: 'Optional platform filter.',
      },
    },
  },
  handler: async ({ identifier, platform }, client) => {
    const { data } = await withProvisioningAccess('Listing bundle IDs', () =>
      client.getAllPages('/v1/bundleIds', {
        query: {
          limit: PAGE_LIMIT,
          'filter[identifier]': identifier,
          'filter[platform]': platform,
        },
      })
    );

    if (data.length === 0) return 'No bundle IDs found for these filters.';

    const body = data
      .map((bundle: any) => {
        const attributes = bundle.attributes ?? {};
        return [
          `• ${attributes.identifier ?? '(no identifier)'} — ${attributes.name ?? '(no name)'}`,
          `   • Platform: ${attributes.platform ?? 'unknown'}`,
          `   • Seed ID: ${attributes.seedId ?? 'n/a'}`,
          `   • Resource ID: ${bundle.id}`,
        ].join('\n');
      })
      .join('\n\n');

    return `Bundle IDs (${data.length}):\n\n${body}\n\nUse the resource ID (not the identifier string) with the capability and profile tools.`;
  },
});

export const createBundleId = defineTool<{
  identifier: string;
  name: string;
  platform: string;
  seedId?: string;
}>({
  name: 'create_bundle_id',
  description:
    'Register a new bundle ID (identifier) on the developer account. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'Reverse-DNS bundle identifier, e.g. "com.example.app". Wildcards ("com.example.*") are allowed for development identifiers.',
      },
      name: {
        type: 'string',
        description: 'Human-readable name shown in the developer portal. Letters, numbers and spaces only.',
      },
      platform: {
        type: 'string',
        enum: [...BUNDLE_ID_PLATFORMS],
        description: 'Target platform. Use UNIVERSAL for an identifier shared by iOS and macOS.',
      },
      seedId: {
        type: 'string',
        description: 'Optional explicit seed ID / team prefix. Leave empty to use the team default.',
      },
    },
    required: ['identifier', 'name', 'platform'],
  },
  handler: async ({ identifier, name, platform, seedId }, client) => {
    const response = await withProvisioningAccess('Creating a bundle ID', () =>
      client.post('/v1/bundleIds', {
        data: {
          type: 'bundleIds',
          attributes: { identifier, name, platform, seedId },
        },
      })
    );

    const created = response?.data;
    return [
      `Registered bundle ID ${identifier}.`,
      `• Name: ${created?.attributes?.name ?? name}`,
      `• Platform: ${created?.attributes?.platform ?? platform}`,
      `• Seed ID: ${created?.attributes?.seedId ?? 'team default'}`,
      `• Resource ID: ${created?.id ?? 'unknown'}`,
    ].join('\n');
  },
});

export const deleteBundleId = defineTool<{ bundleIdResourceId: string; confirm?: boolean }>({
  name: 'delete_bundle_id',
  description:
    'DESTRUCTIVE: delete a registered bundle ID. Its capabilities and every provisioning profile bound to it are lost, which breaks signing for that app. Requires confirm:true and an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      bundleIdResourceId: {
        type: 'string',
        description: 'The bundle ID *resource* ID (from list_bundle_ids), not the "com.example.app" string.',
      },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Deletion is irreversible and invalidates the related provisioning profiles.',
      },
    },
    required: ['bundleIdResourceId'],
  },
  handler: async ({ bundleIdResourceId, confirm }, client) => {
    if (confirm !== true) {
      return (
        `Refusing to delete bundle ID ${bundleIdResourceId}: confirm was not set to true.\n\n` +
        'Deleting an identifier removes its capabilities and invalidates every provisioning ' +
        'profile that references it. An identifier already used by a published app cannot be ' +
        'recreated identically. Re-run with confirm: true to proceed.'
      );
    }

    await withProvisioningAccess('Deleting a bundle ID', () =>
      client.delete(`/v1/bundleIds/${bundleIdResourceId}`)
    );

    return `Deleted bundle ID ${bundleIdResourceId}. Provisioning profiles that referenced it are no longer usable.`;
  },
});

export const listBundleIdCapabilities = defineTool<{ bundleIdResourceId: string }>({
  name: 'list_bundle_id_capabilities',
  description:
    'List the capabilities (push notifications, App Groups, iCloud, Sign in with Apple…) enabled on a bundle ID. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      bundleIdResourceId: {
        type: 'string',
        description: 'The bundle ID resource ID (from list_bundle_ids).',
      },
    },
    required: ['bundleIdResourceId'],
  },
  handler: async ({ bundleIdResourceId }, client) => {
    const { data } = await withProvisioningAccess('Listing bundle ID capabilities', () =>
      client.getAllPages(`/v1/bundleIds/${bundleIdResourceId}/bundleIdCapabilities`, {
        query: { limit: PAGE_LIMIT },
      })
    );

    if (data.length === 0) {
      return `No capabilities enabled on bundle ID ${bundleIdResourceId}.`;
    }

    const body = data
      .map((capability: any) => {
        const settings = capability.attributes?.settings;
        const settingsNote =
          Array.isArray(settings) && settings.length > 0
            ? `\n   • Settings: ${settings
                .map(
                  (setting: any) =>
                    `${setting.key}=${(setting.options ?? [])
                      .filter((option: any) => option.enabled)
                      .map((option: any) => option.key)
                      .join('|') || '(none enabled)'}`
                )
                .join(', ')}`
            : '';

        return `• ${capability.attributes?.capabilityType ?? 'UNKNOWN'}\n   • Capability ID: ${capability.id}${settingsNote}`;
      })
      .join('\n');

    return `Capabilities on bundle ID ${bundleIdResourceId} (${data.length}):\n\n${body}`;
  },
});

export const enableBundleIdCapability = defineTool<{
  bundleIdResourceId: string;
  capabilityType: string;
  settings?: unknown[];
}>({
  name: 'enable_bundle_id_capability',
  description:
    'Enable a capability (PUSH_NOTIFICATIONS, APP_GROUPS, ICLOUD, APPLE_ID_AUTH for Sign in with Apple…) on a bundle ID. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      bundleIdResourceId: {
        type: 'string',
        description: 'The bundle ID resource ID (from list_bundle_ids).',
      },
      capabilityType: {
        type: 'string',
        enum: [...CAPABILITY_TYPES],
        description:
          'Capability identifier. Note the non-obvious ones: APPLE_ID_AUTH = Sign in with Apple, MARZIPAN = Mac Catalyst, ' +
          'AUTOFILL_CREDENTIAL_PROVIDER = AutoFill passwords, HOT_SPOT = Hotspot configuration.',
      },
      settings: {
        type: 'array',
        description:
          `Optional capability settings, passed through verbatim as Apple's \`settings\` array ` +
          `(each entry: { key, options: [{ key, enabled }] }). Required for: ${CAPABILITIES_REQUIRING_SETTINGS}.`,
        items: { type: 'object' },
      },
    },
    required: ['bundleIdResourceId', 'capabilityType'],
  },
  handler: async ({ bundleIdResourceId, capabilityType, settings }, client) => {
    const response = await withProvisioningAccess('Enabling a bundle ID capability', () =>
      client.post('/v1/bundleIdCapabilities', {
        data: {
          type: 'bundleIdCapabilities',
          attributes: { capabilityType, ...(settings ? { settings } : {}) },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
          },
        },
      })
    );

    return [
      `Enabled ${capabilityType} on bundle ID ${bundleIdResourceId}.`,
      `• Capability ID: ${response?.data?.id ?? 'unknown'}`,
      'Provisioning profiles for this identifier must be regenerated to pick up the change.',
    ].join('\n');
  },
});

export const updateBundleIdCapability = defineTool<{
  capabilityId: string;
  capabilityType: string;
  settings?: unknown[];
}>({
  name: 'update_bundle_id_capability',
  description:
    'Update the settings of a capability already enabled on a bundle ID (e.g. switch the iCloud version). Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      capabilityId: {
        type: 'string',
        description: 'The capability resource ID (from list_bundle_id_capabilities).',
      },
      capabilityType: {
        type: 'string',
        enum: [...CAPABILITY_TYPES],
        description: 'The capability type. Apple requires it on updates even when unchanged.',
      },
      settings: {
        type: 'array',
        description:
          `Capability settings array (each entry: { key, options: [{ key, enabled }] }). ` +
          `Required for: ${CAPABILITIES_REQUIRING_SETTINGS}.`,
        items: { type: 'object' },
      },
    },
    required: ['capabilityId', 'capabilityType'],
  },
  handler: async ({ capabilityId, capabilityType, settings }, client) => {
    await withProvisioningAccess('Updating a bundle ID capability', () =>
      client.patch(`/v1/bundleIdCapabilities/${capabilityId}`, {
        data: {
          type: 'bundleIdCapabilities',
          id: capabilityId,
          attributes: { capabilityType, ...(settings ? { settings } : {}) },
        },
      })
    );

    return (
      `Updated capability ${capabilityType} (${capabilityId}).\n` +
      'Regenerate the related provisioning profiles so the change reaches your builds.'
    );
  },
});

export const disableBundleIdCapability = defineTool<{ capabilityId: string; confirm?: boolean }>({
  name: 'disable_bundle_id_capability',
  description:
    'DESTRUCTIVE: disable a capability on a bundle ID. Apps relying on the corresponding entitlement stop building or stop working at runtime. Requires confirm:true and an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      capabilityId: {
        type: 'string',
        description: 'The capability resource ID (from list_bundle_id_capabilities).',
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Disabling invalidates profiles carrying the entitlement and breaks builds that declare it.',
      },
    },
    required: ['capabilityId'],
  },
  handler: async ({ capabilityId, confirm }, client) => {
    if (confirm !== true) {
      return (
        `Refusing to disable capability ${capabilityId}: confirm was not set to true.\n\n` +
        'Removing a capability invalidates the provisioning profiles that carry its entitlement; ' +
        'any build declaring that entitlement will fail to sign. Re-run with confirm: true to proceed.'
      );
    }

    await withProvisioningAccess('Disabling a bundle ID capability', () =>
      client.delete(`/v1/bundleIdCapabilities/${capabilityId}`)
    );

    return `Disabled capability ${capabilityId}. Regenerate the affected provisioning profiles.`;
  },
});

// ---------------------------------------------------------------------------
// 3. Devices
// ---------------------------------------------------------------------------

export const listDevices = defineTool<{ status?: string; platform?: string; name?: string }>({
  name: 'list_registered_devices',
  description:
    'List the devices registered on the developer account with their ENABLED/DISABLED status and UDIDs. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['ENABLED', 'DISABLED'],
        description: 'Optional status filter. Disabled devices still count against the yearly device limit.',
      },
      platform: {
        type: 'string',
        enum: [...DEVICE_PLATFORMS],
        description: 'Optional platform filter.',
      },
      name: { type: 'string', description: 'Optional exact device-name filter.' },
    },
  },
  handler: async ({ status, platform, name }, client) => {
    const { data } = await withProvisioningAccess('Listing devices', () =>
      client.getAllPages('/v1/devices', {
        query: {
          limit: PAGE_LIMIT,
          'filter[status]': status,
          'filter[platform]': platform,
          'filter[name]': name,
        },
      })
    );

    if (data.length === 0) return 'No devices found for these filters.';

    const enabled = data.filter((device: any) => device.attributes?.status === 'ENABLED').length;

    const body = data
      .map((device: any) => {
        const attributes = device.attributes ?? {};
        return [
          `• ${attributes.name ?? '(unnamed)'} — ${attributes.status ?? 'unknown status'}`,
          `   • UDID: ${attributes.udid ?? 'n/a'}`,
          `   • Model: ${attributes.model ?? 'unknown'} (${attributes.deviceClass ?? 'unknown class'}, ${attributes.platform ?? 'unknown platform'})`,
          `   • Added: ${formatDate(attributes.addedDate)}`,
          `   • Device ID: ${device.id}`,
        ].join('\n');
      })
      .join('\n\n');

    return `Registered devices (${data.length} total, ${enabled} enabled):\n\n${body}`;
  },
});

export const registerDevice = defineTool<{ name: string; udid: string; platform: string }>({
  name: 'register_device',
  description:
    'Register a device UDID for development and internal TestFlight installs. The device counts against the yearly per-type limit and cannot be removed before the annual reset. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Label for the device in the developer portal.' },
      udid: {
        type: 'string',
        description: 'The device UDID (40 hex characters, or the newer 24-character form with a dash).',
      },
      platform: {
        type: 'string',
        enum: [...DEVICE_PLATFORMS],
        description: 'Device platform. Use IOS for iPhone, iPad, Apple TV and Apple Watch.',
      },
    },
    required: ['name', 'udid', 'platform'],
  },
  handler: async ({ name, udid, platform }, client) => {
    const response = await withProvisioningAccess('Registering a device', () =>
      client.post('/v1/devices', {
        data: {
          type: 'devices',
          attributes: { name, udid, platform },
        },
      })
    );

    const attributes = response?.data?.attributes ?? {};
    return [
      `Registered device "${attributes.name ?? name}".`,
      `• Status: ${attributes.status ?? 'ENABLED'}`,
      `• UDID: ${attributes.udid ?? udid}`,
      `• Model: ${attributes.model ?? 'unknown'}`,
      `• Device ID: ${response?.data?.id ?? 'unknown'}`,
      'Development and ad-hoc provisioning profiles must be regenerated to include it.',
    ].join('\n');
  },
});

export const updateDevice = defineTool<{ deviceId: string; name?: string; status?: string }>({
  name: 'update_registered_device',
  description:
    'Rename a registered device or disable it. Disabling removes it from newly generated profiles but does not free a slot against the yearly device limit. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: { type: 'string', description: 'The device resource ID (from list_registered_devices).' },
      name: { type: 'string', description: 'New label for the device.' },
      status: {
        type: 'string',
        enum: ['ENABLED', 'DISABLED'],
        description:
          'New status. DISABLED excludes the device from profiles generated afterwards; existing profiles keep working until regenerated.',
      },
    },
    required: ['deviceId'],
  },
  handler: async ({ deviceId, name, status }, client) => {
    if (name === undefined && status === undefined) {
      return 'Nothing to update: provide at least one of name or status.';
    }

    const response = await withProvisioningAccess('Updating a device', () =>
      client.patch(`/v1/devices/${deviceId}`, {
        data: {
          type: 'devices',
          id: deviceId,
          attributes: {
            ...(name !== undefined ? { name } : {}),
            ...(status !== undefined ? { status } : {}),
          },
        },
      })
    );

    const attributes = response?.data?.attributes ?? {};
    return [
      `Updated device ${deviceId}.`,
      `• Name: ${attributes.name ?? name ?? 'unchanged'}`,
      `• Status: ${attributes.status ?? status ?? 'unchanged'}`,
      status === 'DISABLED'
        ? 'Regenerate development/ad-hoc profiles to drop it from their device list.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
});

// ---------------------------------------------------------------------------
// 4. Provisioning profiles
// ---------------------------------------------------------------------------

export const listProvisioningProfiles = defineTool<{
  profileType?: string;
  warningDays?: number;
  onlyProblems?: boolean;
}>({
  name: 'list_provisioning_profiles',
  description:
    'List provisioning profiles with their expiration date and state, flagging expired, expiring or INVALID ones. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      profileType: {
        type: 'string',
        enum: [...PROFILE_TYPES],
        description: 'Optional filter on the profile type.',
      },
      warningDays: {
        type: 'number',
        description: `Days ahead used to flag a profile as expiring soon (default ${DEFAULT_WARNING_DAYS}).`,
      },
      onlyProblems: {
        type: 'boolean',
        description: 'When true, only return expired, soon-to-expire or INVALID profiles.',
      },
    },
  },
  handler: async ({ profileType, warningDays, onlyProblems }, client) => {
    const window = warningDays ?? DEFAULT_WARNING_DAYS;

    const profiles = await withProvisioningAccess('Listing provisioning profiles', () =>
      fetchProfiles(client, profileType)
    );

    if (profiles.length === 0) {
      return profileType
        ? `No provisioning profiles of type ${profileType} found.`
        : 'No provisioning profiles found on this account.';
    }

    const sorted = [...profiles].sort((a, b) => byExpiration(a.expirationDate, b.expirationDate));
    const rows = sorted
      .map((profile) => ({ profile, level: expiryLevel(profile.expirationDate, window) }))
      .filter(({ profile, level }) =>
        onlyProblems
          ? level === 'expired' || level === 'expiring' || profile.profileState === 'INVALID'
          : true
      );

    if (rows.length === 0) {
      return `All ${profiles.length} provisioning profile(s) are ACTIVE and valid for more than ${window} day(s).`;
    }

    const body = rows
      .map(({ profile, level }) => {
        const invalid = profile.profileState === 'INVALID' ? ' [INVALID]' : '';
        return [
          `${statusMarker(level)}${invalid} ${profile.name}`,
          `   • Type: ${profile.profileType ?? 'unknown'} (${profile.platform ?? 'unknown platform'})`,
          `   • State: ${profile.profileState ?? 'unknown'}`,
          `   • ${expiryLabel(profile.expirationDate, window)}`,
          `   • Certificates referenced: ${profile.certificateIds.length}`,
          `   • UUID: ${profile.uuid ?? 'n/a'}`,
          `   • Profile ID: ${profile.id}`,
        ].join('\n');
      })
      .join('\n\n');

    return `Provisioning profiles (${profiles.length} total, ${rows.length} shown):\n\n${body}`;
  },
});

export const getProvisioningProfile = defineTool<{ profileId: string; outputPath?: string }>({
  name: 'get_provisioning_profile',
  description:
    'Get one provisioning profile (type, state, expiration) and optionally save it as a local .mobileprovision file instead of printing base64. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile resource ID.' },
      outputPath: {
        type: 'string',
        description:
          'Optional local path for the profile file, e.g. "./MyApp_AppStore.mobileprovision". Omit to skip writing.',
      },
    },
    required: ['profileId'],
  },
  handler: async ({ profileId, outputPath }, client) => {
    const response = await withProvisioningAccess('Reading a provisioning profile', () =>
      client.get(`/v1/profiles/${profileId}`)
    );

    const attributes = response?.data?.attributes ?? {};
    const fileNote = await describeBinaryPayload({
      base64: attributes.profileContent,
      outputPath,
      suggestedName: `${(attributes.name || 'profile').replace(/\s+/g, '_')}.mobileprovision`,
      kind: 'Provisioning profile',
    });

    return [
      `Provisioning profile: ${attributes.name ?? profileId}`,
      `• Type: ${attributes.profileType ?? 'unknown'} (${attributes.platform ?? 'unknown platform'})`,
      `• State: ${attributes.profileState ?? 'unknown'}`,
      `• ${expiryLabel(attributes.expirationDate, DEFAULT_WARNING_DAYS)}`,
      `• UUID: ${attributes.uuid ?? 'n/a'}`,
      `• Profile ID: ${profileId}`,
      '',
      fileNote,
    ].join('\n');
  },
});

export const createProvisioningProfile = defineTool<{
  name: string;
  profileType: string;
  bundleIdResourceId: string;
  certificateIds: string[];
  deviceIds?: string[];
  outputPath?: string;
}>({
  name: 'create_provisioning_profile',
  description:
    'Create a provisioning profile from a bundle ID, certificates and (for development/ad-hoc) devices, optionally saving the .mobileprovision locally. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Profile name shown in the developer portal. Must be unique.' },
      profileType: {
        type: 'string',
        enum: [...PROFILE_TYPES],
        description:
          'Profile type. IOS_APP_STORE for App Store/TestFlight builds, IOS_APP_DEVELOPMENT and IOS_APP_ADHOC require a device list.',
      },
      bundleIdResourceId: {
        type: 'string',
        description: 'The bundle ID *resource* ID (from list_bundle_ids), not the "com.example.app" string.',
      },
      certificateIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Certificate resource IDs to embed. Use a distribution certificate for store/ad-hoc profiles, a development one for development profiles.',
      },
      deviceIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Device resource IDs. Required for IOS_APP_DEVELOPMENT and IOS_APP_ADHOC; ignored for App Store profiles.',
      },
      outputPath: {
        type: 'string',
        description:
          'Optional local path for the generated profile, e.g. "./MyApp_AppStore.mobileprovision". Recommended: the profile is otherwise only returned as base64 and not printed.',
      },
    },
    required: ['name', 'profileType', 'bundleIdResourceId', 'certificateIds'],
  },
  handler: async (
    { name, profileType, bundleIdResourceId, certificateIds, deviceIds, outputPath },
    client
  ) => {
    if (!Array.isArray(certificateIds) || certificateIds.length === 0) {
      return 'At least one certificate ID is required to create a provisioning profile.';
    }

    const needsDevices = profileType.includes('DEVELOPMENT') || profileType.includes('ADHOC');
    if (needsDevices && (!deviceIds || deviceIds.length === 0)) {
      return `Profile type ${profileType} requires at least one device ID. List them with list_registered_devices.`;
    }

    const relationships: Record<string, unknown> = {
      bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
      certificates: {
        data: certificateIds.map((id) => ({ type: 'certificates', id })),
      },
    };

    if (deviceIds && deviceIds.length > 0) {
      relationships.devices = { data: deviceIds.map((id) => ({ type: 'devices', id })) };
    }

    const response = await withProvisioningAccess('Creating a provisioning profile', () =>
      client.post('/v1/profiles', {
        data: {
          type: 'profiles',
          attributes: { name, profileType },
          relationships,
        },
      })
    );

    const created = response?.data;
    const attributes = created?.attributes ?? {};

    const fileNote = await describeBinaryPayload({
      base64: attributes.profileContent,
      outputPath,
      suggestedName: `${name.replace(/\s+/g, '_')}.mobileprovision`,
      kind: 'Provisioning profile',
    });

    return [
      `Created provisioning profile "${attributes.name ?? name}".`,
      `• Type: ${attributes.profileType ?? profileType}`,
      `• State: ${attributes.profileState ?? 'unknown'}`,
      `• ${expiryLabel(attributes.expirationDate, DEFAULT_WARNING_DAYS)}`,
      `• UUID: ${attributes.uuid ?? 'n/a'}`,
      `• Profile ID: ${created?.id ?? 'unknown'}`,
      '',
      fileNote,
    ].join('\n');
  },
});

export const deleteProvisioningProfile = defineTool<{ profileId: string; confirm?: boolean }>({
  name: 'delete_provisioning_profile',
  description:
    'DESTRUCTIVE: delete a provisioning profile. Any CI job or local build still referencing it fails to sign until a new profile is generated and installed. Requires confirm:true and an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile resource ID to delete.' },
      confirm: {
        type: 'boolean',
        description: 'Must be true. Deletion is irreversible; the profile UUID cannot be recovered.',
      },
    },
    required: ['profileId'],
  },
  handler: async ({ profileId, confirm }, client) => {
    if (confirm !== true) {
      return (
        `Refusing to delete provisioning profile ${profileId}: confirm was not set to true.\n\n` +
        'Builds and CI pipelines pinned to this profile stop signing as soon as it is gone, ' +
        'and its UUID cannot be recreated. Re-run with confirm: true to proceed.'
      );
    }

    let label = profileId;
    try {
      const existing = await client.get(`/v1/profiles/${profileId}`);
      const attributes = existing?.data?.attributes ?? {};
      label = `${attributes.name ?? profileId} (${attributes.profileType ?? 'unknown type'})`;
    } catch (error) {
      if (isAccessDenied(error)) throw error;
      // A failed lookup should not block the deletion itself.
    }

    await withProvisioningAccess('Deleting a provisioning profile', () =>
      client.delete(`/v1/profiles/${profileId}`)
    );

    return `Deleted provisioning profile ${label}. Regenerate and reinstall a replacement before the next signed build.`;
  },
});

// ---------------------------------------------------------------------------
// 5. Signing health diagnostic
// ---------------------------------------------------------------------------

export const checkSigningHealth = defineTool<{ warningDays?: number }>({
  name: 'check_signing_health',
  description:
    'Cross-check certificates, provisioning profiles and devices to report what will break signing soon: certificates expiring within N days, expired or INVALID profiles, and profiles referencing a revoked certificate. Requires an API key with the Admin or Developer role.',
  inputSchema: {
    type: 'object',
    properties: {
      warningDays: {
        type: 'number',
        description: `How far ahead to look for upcoming expirations (default ${DEFAULT_WARNING_DAYS} days).`,
      },
    },
  },
  handler: async ({ warningDays }, client) => {
    const window = warningDays ?? DEFAULT_WARNING_DAYS;

    let certificates: CertificateRecord[];
    let profiles: ProfileRecord[];

    try {
      // Sequential rather than parallel: a role failure on the first call makes
      // the second one pointless, and Apple rate-limits aggressively.
      certificates = await fetchCertificates(client);
      profiles = await fetchProfiles(client);
    } catch (error) {
      if (isAccessDenied(error)) {
        throw new Error(
          `The signing health check could not read your certificates and profiles (HTTP ${
            (error as AppStoreApiError).httpStatus
          }).\n\n${ROLE_HINT}\n\nApple's response: ${(error as AppStoreApiError).message}`
        );
      }
      throw error;
    }

    // Devices are informational only — a failure here must not sink the report.
    let deviceSummary = 'Devices: not retrieved.';
    try {
      const { data } = await client.getAllPages('/v1/devices', { query: { limit: PAGE_LIMIT } });
      const enabled = data.filter((device: any) => device.attributes?.status === 'ENABLED').length;
      deviceSummary = `Devices: ${data.length} registered, ${enabled} enabled, ${data.length - enabled} disabled.`;
    } catch {
      deviceSummary = 'Devices: could not be read (non-fatal).';
    }

    const liveCertificateIds = new Set(certificates.map((cert) => cert.id));

    const expiredCertificates = certificates.filter(
      (cert) => expiryLevel(cert.expirationDate, window) === 'expired'
    );
    const expiringCertificates = certificates.filter(
      (cert) => expiryLevel(cert.expirationDate, window) === 'expiring'
    );

    const expiredProfiles = profiles.filter(
      (profile) => expiryLevel(profile.expirationDate, window) === 'expired'
    );
    const expiringProfiles = profiles.filter(
      (profile) => expiryLevel(profile.expirationDate, window) === 'expiring'
    );
    const invalidProfiles = profiles.filter((profile) => profile.profileState === 'INVALID');

    // A revoked certificate simply disappears from /v1/certificates, so a
    // profile pointing at an ID that no longer exists is the detectable symptom.
    const profilesWithMissingCertificates = profiles
      .map((profile) => ({
        profile,
        missing: profile.certificateIds.filter((id) => !liveCertificateIds.has(id)),
      }))
      .filter((entry) => entry.missing.length > 0);

    // A profile whose embedded certificate expires before the profile does will
    // stop signing on the certificate's date, not the profile's.
    const certificateById = new Map(certificates.map((cert) => [cert.id, cert]));
    const profilesOnDyingCertificates = profiles
      .map((profile) => ({
        profile,
        doomed: profile.certificateIds
          .map((id) => certificateById.get(id))
          .filter((cert): cert is CertificateRecord => {
            if (!cert) return false;
            const level = expiryLevel(cert.expirationDate, window);
            return level === 'expired' || level === 'expiring';
          }),
      }))
      .filter((entry) => entry.doomed.length > 0);

    const sections: string[] = [];

    sections.push(
      `Signing health check — window: ${window} day(s)\n` +
        `Certificates: ${certificates.length} • Provisioning profiles: ${profiles.length}\n` +
        deviceSummary
    );

    if (expiredCertificates.length > 0) {
      sections.push(
        `CRITICAL — ${expiredCertificates.length} expired certificate(s):\n` +
          expiredCertificates
            .map(
              (cert) =>
                `  • ${cert.displayName || cert.name} (${cert.certificateType ?? 'unknown'}) — ${expiryLabel(cert.expirationDate, window)} [${cert.id}]`
            )
            .join('\n')
      );
    }

    if (expiringCertificates.length > 0) {
      sections.push(
        `WARNING — ${expiringCertificates.length} certificate(s) expiring within ${window} day(s):\n` +
          expiringCertificates
            .sort((a, b) => byExpiration(a.expirationDate, b.expirationDate))
            .map(
              (cert) =>
                `  • ${cert.displayName || cert.name} (${cert.certificateType ?? 'unknown'}) — ${expiryLabel(cert.expirationDate, window)} [${cert.id}]`
            )
            .join('\n')
      );
    }

    if (profilesWithMissingCertificates.length > 0) {
      sections.push(
        `CRITICAL — ${profilesWithMissingCertificates.length} profile(s) referencing a certificate that no longer exists (revoked or deleted):\n` +
          profilesWithMissingCertificates
            .map(
              ({ profile, missing }) =>
                `  • ${profile.name} (${profile.profileType ?? 'unknown'}) — missing certificate(s): ${missing.join(', ')} [${profile.id}]`
            )
            .join('\n')
      );
    }

    if (invalidProfiles.length > 0) {
      sections.push(
        `CRITICAL — ${invalidProfiles.length} profile(s) in state INVALID (regenerate them):\n` +
          invalidProfiles
            .map(
              (profile) =>
                `  • ${profile.name} (${profile.profileType ?? 'unknown'}) — ${expiryLabel(profile.expirationDate, window)} [${profile.id}]`
            )
            .join('\n')
      );
    }

    if (expiredProfiles.length > 0) {
      sections.push(
        `CRITICAL — ${expiredProfiles.length} expired profile(s):\n` +
          expiredProfiles
            .map(
              (profile) =>
                `  • ${profile.name} (${profile.profileType ?? 'unknown'}) — ${expiryLabel(profile.expirationDate, window)} [${profile.id}]`
            )
            .join('\n')
      );
    }

    if (expiringProfiles.length > 0) {
      sections.push(
        `WARNING — ${expiringProfiles.length} profile(s) expiring within ${window} day(s):\n` +
          expiringProfiles
            .sort((a, b) => byExpiration(a.expirationDate, b.expirationDate))
            .map(
              (profile) =>
                `  • ${profile.name} (${profile.profileType ?? 'unknown'}) — ${expiryLabel(profile.expirationDate, window)} [${profile.id}]`
            )
            .join('\n')
      );
    }

    if (profilesOnDyingCertificates.length > 0) {
      sections.push(
        `WARNING — ${profilesOnDyingCertificates.length} profile(s) whose embedded certificate expires first (they stop signing on the certificate's date):\n` +
          profilesOnDyingCertificates
            .map(
              ({ profile, doomed }) =>
                `  • ${profile.name} — via ${doomed
                  .map((cert) => `${cert.displayName || cert.name} (${formatDate(cert.expirationDate)})`)
                  .join(', ')} [${profile.id}]`
            )
            .join('\n')
      );
    }

    if (sections.length === 1) {
      sections.push(
        `No problems found: every certificate and provisioning profile is valid for more than ${window} day(s), ` +
          'and no profile references a missing certificate.'
      );
    } else {
      sections.push(
        'Next steps: renew expiring certificates before their date, then regenerate every profile ' +
          'that embeds them (create_signing_certificate, then create_provisioning_profile). ' +
          'Do not revoke the old certificate until the new builds are shipped.'
      );
    }

    return sections.join('\n\n');
  },
});

export const provisioningTools: Tool[] = [
  // Certificates
  listCertificates,
  getCertificate,
  createCertificate,
  revokeCertificate,
  // Bundle IDs
  listBundleIds,
  createBundleId,
  deleteBundleId,
  listBundleIdCapabilities,
  enableBundleIdCapability,
  updateBundleIdCapability,
  disableBundleIdCapability,
  // Devices
  listDevices,
  registerDevice,
  updateDevice,
  // Provisioning profiles
  listProvisioningProfiles,
  getProvisioningProfile,
  createProvisioningProfile,
  deleteProvisioningProfile,
  // Diagnostic
  checkSigningHealth,
];
