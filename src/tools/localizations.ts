/**
 * Tools for App Store version localizations — the per-language store listing.
 *
 * `update_app_store_version_localization` (src/tools/versions.ts) can write a
 * listing, but it needs a locale that already exists, and nothing else in the
 * server could read localizations back. Their ids are required by every
 * screenshot and preview tool (`screenshots_list_sets` takes a
 * `localizationId`), so without a listing tool the whole media workflow is
 * unreachable.
 *
 * Resources involved:
 *   GET    /v1/appStoreVersions/{id}/appStoreVersionLocalizations
 *   GET    /v1/appStoreVersionLocalizations/{id}
 *   POST   /v1/appStoreVersionLocalizations
 *   DELETE /v1/appStoreVersionLocalizations/{id}
 *
 * Note on the shape Apple returns: an empty field comes back as `null`, not as
 * an absent key, and `promotionalText` is `null` far more often than not. Any
 * formatting here must treat `null`, `undefined` and `''` identically or it
 * reports "filled" for fields that are empty.
 */

import { defineTool, type Tool } from './types.js';
import type { AppStoreClient } from '../appstore-client.js';

// ---------------------------------------------------------------------------
// Apple's locale codes
// ---------------------------------------------------------------------------

/**
 * Locale codes accepted by `appStoreVersionLocalizations.locale`.
 *
 * Apple is not consistent here: most codes carry a region (`fr-FR`, `pt-BR`),
 * but a handful are language-only (`ja`, `ko`, `it`, `vi`, `th`, `hi`, `ms`,
 * `id`, `ro`, `hr`, `ca`, `el`, `he`, `pl`, `uk`, `cs`, `sk`, `hu`, `no`, `fi`,
 * `da`, `nl-NL` is regioned but `sv` is not...). Passing `ja-JP` or `en` is
 * rejected with ENTITY_ERROR.ATTRIBUTE.INVALID, so the exact spelling matters.
 *
 * The list below is the App Store Connect API set as documented by Apple. It is
 * used for validation hints and by `localizations_supported_locales`; an unknown
 * code is still forwarded to Apple (which arbitrates) rather than blocked, since
 * Apple adds languages over time.
 */
const APPLE_LOCALES: Array<{ code: string; label: string }> = [
  { code: 'ar-SA', label: 'Arabic' },
  { code: 'ca', label: 'Catalan (no region)' },
  { code: 'cs', label: 'Czech (no region)' },
  { code: 'da', label: 'Danish (no region)' },
  { code: 'de-DE', label: 'German' },
  { code: 'el', label: 'Greek (no region)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'en-CA', label: 'English (Canada)' },
  { code: 'en-GB', label: 'English (U.K.)' },
  { code: 'en-US', label: 'English (U.S.) — the usual primary locale' },
  { code: 'es-ES', label: 'Spanish (Spain)' },
  { code: 'es-MX', label: 'Spanish (Mexico)' },
  { code: 'fi', label: 'Finnish (no region)' },
  { code: 'fr-CA', label: 'French (Canada)' },
  { code: 'fr-FR', label: 'French (France)' },
  { code: 'he', label: 'Hebrew (no region)' },
  { code: 'hi', label: 'Hindi (no region)' },
  { code: 'hr', label: 'Croatian (no region)' },
  { code: 'hu', label: 'Hungarian (no region)' },
  { code: 'id', label: 'Indonesian (no region)' },
  { code: 'it', label: 'Italian (no region)' },
  { code: 'ja', label: 'Japanese (no region — "ja-JP" is rejected)' },
  { code: 'ko', label: 'Korean (no region — "ko-KR" is rejected)' },
  { code: 'ms', label: 'Malay (no region)' },
  { code: 'nl-NL', label: 'Dutch' },
  { code: 'no', label: 'Norwegian (no region)' },
  { code: 'pl', label: 'Polish (no region)' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'ro', label: 'Romanian (no region)' },
  { code: 'ru', label: 'Russian (no region)' },
  { code: 'sk', label: 'Slovak (no region)' },
  { code: 'sv', label: 'Swedish (no region)' },
  { code: 'th', label: 'Thai (no region)' },
  { code: 'tr', label: 'Turkish (no region)' },
  { code: 'uk', label: 'Ukrainian (no region)' },
  { code: 'vi', label: 'Vietnamese (no region)' },
  { code: 'zh-Hans', label: 'Chinese Simplified (script, not region)' },
  { code: 'zh-Hant', label: 'Chinese Traditional (script, not region)' },
];

const LOCALE_CODES = APPLE_LOCALES.map((l) => l.code);

/** Apple's character caps per localized field. */
const FIELD_LIMITS = {
  description: 4000,
  keywords: 100,
  promotionalText: 170,
  whatsNew: 4000,
  supportUrl: 255,
  marketingUrl: 255,
} as const;

type FieldName = keyof typeof FIELD_LIMITS;

const FIELD_ORDER: FieldName[] = [
  'description',
  'keywords',
  'promotionalText',
  'whatsNew',
  'supportUrl',
  'marketingUrl',
];

/**
 * Fields App Store Connect refuses to submit without.
 *
 * `whatsNew` is required only for an update (a version that follows a released
 * one); on a first version Apple hides the field entirely, so it is handled
 * separately by the diagnostic tool rather than listed here.
 */
const REQUIRED_FIELDS: FieldName[] = ['description', 'supportUrl'];

// ---------------------------------------------------------------------------
// Local helpers
//
// These live here on purpose: AppStoreClient is owned by another module and
// exposes only the generic get/post/patch/delete helpers, which is all that is
// needed.
// ---------------------------------------------------------------------------

interface LocalizationResource {
  id: string;
  attributes: Partial<Record<FieldName, string | null>> & { locale?: string };
}

/** Apple returns `null` for an empty field; treat blank strings the same way. */
function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function charCount(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

async function fetchLocalizations(
  client: AppStoreClient,
  versionId: string
): Promise<LocalizationResource[]> {
  const { data } = await client.getAllPages<LocalizationResource>(
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    { query: { limit: 200 } }
  );
  return data;
}

async function fetchLocalization(
  client: AppStoreClient,
  localizationId: string
): Promise<LocalizationResource> {
  const response = await client.get(`/v1/appStoreVersionLocalizations/${localizationId}`);
  return response.data as LocalizationResource;
}

/** Resolve a localization from either its id, or a (versionId, locale) pair. */
async function resolveLocalization(
  client: AppStoreClient,
  args: { localizationId?: string; versionId?: string; locale?: string }
): Promise<LocalizationResource> {
  if (args.localizationId) {
    return fetchLocalization(client, args.localizationId);
  }

  if (!args.versionId || !args.locale) {
    throw new Error('Pass either `localizationId`, or both `versionId` and `locale`.');
  }

  const localizations = await fetchLocalizations(client, args.versionId);
  const match = localizations.find((l) => l.attributes?.locale === args.locale);

  if (!match) {
    const available = localizations.map((l) => l.attributes?.locale).join(', ') || 'none';
    throw new Error(
      `Version ${args.versionId} has no "${args.locale}" localization. Existing locales: ${available}.`
    );
  }

  return match;
}

/** Version metadata needed to decide whether whatsNew is mandatory. */
async function fetchVersionSummary(
  client: AppStoreClient,
  versionId: string
): Promise<{ versionString?: string; appStoreState?: string; platform?: string; appId?: string }> {
  const response = await client.get(`/v1/appStoreVersions/${versionId}`, {
    query: { include: 'app' },
  });

  return {
    versionString: response.data?.attributes?.versionString,
    appStoreState: response.data?.attributes?.appStoreState,
    platform: response.data?.attributes?.platform,
    appId: response.data?.relationships?.app?.data?.id,
  };
}

function summarizeFields(attributes: LocalizationResource['attributes']): string {
  const filled = FIELD_ORDER.filter((field) => isFilled(attributes?.[field]));
  const empty = FIELD_ORDER.filter((field) => !isFilled(attributes?.[field]));

  return [
    filled.length > 0 ? `filled: ${filled.join(', ')}` : 'filled: none',
    empty.length > 0 ? `empty: ${empty.join(', ')}` : 'empty: none',
  ].join(' | ');
}

/** "keywords: 88/100 (12 left)" — the number that actually saves time. */
function formatUsage(field: FieldName, value: unknown): string {
  const limit = FIELD_LIMITS[field];
  const used = charCount(value);

  if (!isFilled(value)) return `${field}: empty (0/${limit})`;

  const remaining = limit - used;
  const flag = remaining < 0 ? ' ⚠️ OVER LIMIT' : '';
  return `${field}: ${used}/${limit} (${remaining} left)${flag}`;
}

function indent(text: string, prefix = '   '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tools — reading
// ---------------------------------------------------------------------------

export const listLocalizations = defineTool<{ versionId: string }>({
  name: 'localizations_list',
  description:
    'List the localizations of an app store version: locale, localization ID (needed by the screenshot tools) and which listing fields are filled or empty',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: {
        type: 'string',
        description:
          'The ID of the appStoreVersion (from list_app_store_versions, not the version string)',
      },
    },
    required: ['versionId'],
  },
  handler: async ({ versionId }, client) => {
    const localizations = await fetchLocalizations(client, versionId);

    if (localizations.length === 0) {
      return `Version ${versionId} has no localization yet. Create one with localizations_create.`;
    }

    const lines = localizations
      .slice()
      .sort((a, b) => (a.attributes?.locale ?? '').localeCompare(b.attributes?.locale ?? ''))
      .map((localization) => {
        const locale = localization.attributes?.locale ?? '(unknown locale)';
        const missingRequired = REQUIRED_FIELDS.filter(
          (field) => !isFilled(localization.attributes?.[field])
        );
        const badge = missingRequired.length > 0 ? ' ⚠️ incomplete' : ' ✅';

        return `• ${locale}${badge}\n   • localization ID: ${localization.id}\n   • ${summarizeFields(
          localization.attributes
        )}`;
      });

    return `🌍 ${localizations.length} localization(s) on version ${versionId}:\n\n${lines.join(
      '\n'
    )}\n\nUse the localization ID with screenshots_list_sets / localizations_get.`;
  },
});

export const getLocalization = defineTool<{
  localizationId?: string;
  versionId?: string;
  locale?: string;
  full?: boolean;
}>({
  name: 'localizations_get',
  description:
    "Read one app store version localization in full, with each field's character count against Apple's limit",
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the appStoreVersionLocalization (preferred)',
      },
      versionId: {
        type: 'string',
        description: 'The ID of the appStoreVersion — use together with `locale` instead of an ID',
      },
      locale: {
        type: 'string',
        description: 'Locale code such as "fr-FR" or "ja" — use together with `versionId`',
      },
      full: {
        type: 'boolean',
        description:
          'Print the whole description and whatsNew instead of a 300-character excerpt (default false)',
      },
    },
    required: [],
  },
  handler: async (args, client) => {
    const localization = await resolveLocalization(client, args);
    const attributes = localization.attributes ?? {};
    const excerptLength = args.full ? Number.MAX_SAFE_INTEGER : 300;

    const usage = FIELD_ORDER.map((field) => `• ${formatUsage(field, attributes[field])}`).join('\n');

    const contentBlocks = FIELD_ORDER.map((field) => {
      const value = attributes[field];
      if (!isFilled(value)) return `── ${field} ──\n   (empty)`;

      const truncated =
        value.length > excerptLength ? `${value.slice(0, excerptLength)}…  [+${value.length - excerptLength} chars, pass full:true]` : value;

      return `── ${field} ──\n${indent(truncated)}`;
    }).join('\n\n');

    const missingRequired = REQUIRED_FIELDS.filter((field) => !isFilled(attributes[field]));
    const status =
      missingRequired.length > 0
        ? `⚠️ Missing required field(s): ${missingRequired.join(', ')}`
        : '✅ All fields required for submission are filled.';

    return `🌍 Localization ${attributes.locale ?? '(unknown locale)'} (${localization.id})

${status}

Character usage:
${usage}

${contentBlocks}`;
  },
});

export const listSupportedLocales = defineTool<{ search?: string }>({
  name: 'localizations_supported_locales',
  description:
    'List the locale codes App Store Connect accepts for a version localization, flagging the ones that carry no region',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description: 'Optional filter, matched against the code and the language name (e.g. "chi")',
      },
    },
    required: [],
  },
  handler: async ({ search }) => {
    const needle = search?.trim().toLowerCase();
    const matches = needle
      ? APPLE_LOCALES.filter(
          (l) => l.code.toLowerCase().includes(needle) || l.label.toLowerCase().includes(needle)
        )
      : APPLE_LOCALES;

    if (matches.length === 0) {
      return `No App Store locale matches "${search}".`;
    }

    const lines = matches.map((l) => `• ${l.code.padEnd(8)} ${l.label}`).join('\n');

    return `🌐 ${matches.length} App Store locale code(s)${search ? ` matching "${search}"` : ''}:

${lines}

Watch out: several languages take no region ("ja", not "ja-JP"; "ko", not "ko-KR"),
Chinese uses a script subtag ("zh-Hans" / "zh-Hant"), and English/Spanish/French/
Portuguese require an explicit region ("en-US", "es-ES", "fr-FR", "pt-BR").
Apple rejects anything else with ENTITY_ERROR.ATTRIBUTE.INVALID.`;
  },
});

// ---------------------------------------------------------------------------
// Tool — multi-language readiness diagnostic
// ---------------------------------------------------------------------------

export const diagnoseLocalizations = defineTool<{ versionId: string; requiredDisplayType?: string }>({
  name: 'localizations_diagnose',
  description:
    'Submission readiness report for every locale of a version: missing required listing fields, over-limit fields, and locales without screenshots',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the appStoreVersion' },
      requiredDisplayType: {
        type: 'string',
        description:
          'Pin the check to one exact screenshot display type (e.g. APP_IPHONE_67). Left out, a locale only needs at least one non-empty iPhone set, which is what Apple actually enforces — a live app with APP_IPHONE_65 alone passes review.',
      },
    },
    required: ['versionId'],
  },
  handler: async ({ versionId, requiredDisplayType }, client) => {
    const [version, localizations] = await Promise.all([
      fetchVersionSummary(client, versionId).catch(() => ({}) as Awaited<
        ReturnType<typeof fetchVersionSummary>
      >),
      fetchLocalizations(client, versionId),
    ]);

    if (localizations.length === 0) {
      return `Version ${versionId} has no localization at all — it cannot be submitted. Create one with localizations_create.`;
    }

    // whatsNew is only demanded once a previous version has shipped.
    const isFirstVersion = version.versionString === '1.0' || version.versionString === '1.0.0';
    const requiredFields: FieldName[] = isFirstVersion
      ? REQUIRED_FIELDS
      : [...REQUIRED_FIELDS, 'whatsNew'];

    const screenshotRequirement = requiredDisplayType
      ? `a non-empty ${requiredDisplayType} set`
      : 'at least one non-empty iPhone screenshot set';

    const results = await Promise.all(
      localizations.map(async (localization) => {
        const locale = localization.attributes?.locale ?? '(unknown locale)';
        const attributes = localization.attributes ?? {};

        const missing = requiredFields.filter((field) => !isFilled(attributes[field]));
        const overLimit = FIELD_ORDER.filter(
          (field) => charCount(attributes[field]) > FIELD_LIMITS[field]
        );

        let setSummary: string;
        let hasRequiredSet = false;
        try {
          const { data: sets } = await client.getAllPages(
            `/v1/appStoreVersionLocalizations/${localization.id}/appScreenshotSets`
          );

          if (sets.length === 0) {
            setSummary = 'no screenshot set';
          } else {
            const counts = await Promise.all(
              (sets as any[]).map(async (set) => {
                const { data: shots } = await client.getAllPages(
                  `/v1/appScreenshotSets/${set.id}/appScreenshots`
                );
                return {
                  displayType: set.attributes?.screenshotDisplayType ?? '(unknown type)',
                  count: shots.length,
                };
              })
            );

            hasRequiredSet = counts.some((c) =>
              requiredDisplayType
                ? c.displayType === requiredDisplayType && c.count > 0
                : c.displayType.startsWith('APP_IPHONE_') && c.count > 0
            );
            setSummary = counts.map((c) => `${c.displayType}=${c.count}`).join(', ');
          }
        } catch (error: any) {
          setSummary = `screenshot sets unreadable (${error?.message ?? error})`;
        }

        const issues: string[] = [];
        if (missing.length > 0) issues.push(`missing required field(s): ${missing.join(', ')}`);
        if (overLimit.length > 0) {
          issues.push(
            `over Apple's limit: ${overLimit
              .map((f) => `${f} ${charCount(attributes[f])}/${FIELD_LIMITS[f]}`)
              .join(', ')}`
          );
        }
        if (!hasRequiredSet) {
          issues.push(
            requiredDisplayType ? `no ${requiredDisplayType} screenshot` : 'no iPhone screenshot'
          );
        }

        const badge = issues.length === 0 ? '✅' : '⚠️';
        return {
          locale,
          issues,
          block: `${badge} ${locale} (${localization.id})
   • screenshots: ${setSummary}
   • ${summarizeFields(attributes)}${
     issues.length > 0 ? `\n   • blocking: ${issues.join('; ')}` : ''
   }`,
        };
      })
    );

    // Sorted by locale so two runs of the same version read identically; the
    // Promise.all above resolves in network order, which is not stable.
    results.sort((a, b) => a.locale.localeCompare(b.locale));
    const blockers = results.filter((r) => r.issues.length > 0);

    const header = `🩺 Submission readiness — version ${
      version.versionString ?? versionId
    }${version.appStoreState ? ` (${version.appStoreState})` : ''}
Required listing fields: ${requiredFields.join(', ')}${
      isFirstVersion ? ' — whatsNew not required on a first version' : ''
    }
Required screenshots: ${screenshotRequirement}`;

    const verdict =
      blockers.length === 0
        ? `\n✅ All ${localizations.length} locale(s) look submittable.`
        : `\n⚠️ ${blockers.length} of ${localizations.length} locale(s) block submission:\n${blockers
            .map((b) => `   • ${b.locale}: ${b.issues.join('; ')}`)
            .join('\n')}`;

    return `${header}\n\n${results.map((r) => r.block).join('\n\n')}\n${verdict}`;
  },
});

// ---------------------------------------------------------------------------
// Tools — writing
//
// Neither of these has been executed against the production account. They are
// written against Apple's documented request shapes.
// ---------------------------------------------------------------------------

export const createLocalization = defineTool<{
  versionId: string;
  locale: string;
  description?: string;
  keywords?: string;
  whatsNew?: string;
  promotionalText?: string;
  supportUrl?: string;
  marketingUrl?: string;
}>({
  name: 'localizations_create',
  description:
    'Create an app store version localization for a new language (POST /v1/appStoreVersionLocalizations), optionally with its listing content',
  inputSchema: {
    type: 'object',
    properties: {
      versionId: { type: 'string', description: 'The ID of the appStoreVersion' },
      locale: {
        type: 'string',
        description: `Locale code. Mind Apple's spelling — see localizations_supported_locales. One of: ${LOCALE_CODES.join(
          ', '
        )}`,
      },
      description: { type: 'string', description: `App description (${FIELD_LIMITS.description} chars max)` },
      keywords: {
        type: 'string',
        description: `Comma-separated search keywords (${FIELD_LIMITS.keywords} chars max, commas included)`,
      },
      whatsNew: {
        type: 'string',
        description: `Release notes (${FIELD_LIMITS.whatsNew} chars max). Rejected on a first version.`,
      },
      promotionalText: {
        type: 'string',
        description: `Promotional text (${FIELD_LIMITS.promotionalText} chars max)`,
      },
      supportUrl: { type: 'string', description: 'Support URL — required before submission' },
      marketingUrl: { type: 'string', description: 'Marketing URL (optional)' },
    },
    required: ['versionId', 'locale'],
  },
  handler: async (args, client) => {
    const { versionId, locale, ...content } = args;

    const overLimit = FIELD_ORDER.filter(
      (field) => charCount((content as any)[field]) > FIELD_LIMITS[field]
    );
    if (overLimit.length > 0) {
      throw new Error(
        `Refusing to send fields over Apple's limit: ${overLimit
          .map((f) => `${f} ${charCount((content as any)[f])}/${FIELD_LIMITS[f]}`)
          .join(', ')}`
      );
    }

    const attributes: Record<string, string> = { locale };
    for (const field of FIELD_ORDER) {
      const value = (content as any)[field];
      if (value !== undefined) attributes[field] = value;
    }

    const response = await client.post('/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes,
        relationships: {
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });

    const created = response.data as LocalizationResource;

    return `✅ Localization created:
• Locale: ${created.attributes?.locale ?? locale}
• Localization ID: ${created.id}
• Version ID: ${versionId}
• ${summarizeFields(created.attributes ?? {})}

Next: attach screenshots with screenshots_upload using localizationId ${created.id}.`;
  },
});

export const deleteLocalization = defineTool<{ localizationId: string; confirm?: boolean }>({
  name: 'localizations_delete',
  description:
    'Delete an app store version localization and everything attached to it (screenshots and previews included). Requires confirm: true.',
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the appStoreVersionLocalization to delete',
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true. Deleting a localization also destroys its screenshot and preview sets; there is no undo.',
      },
    },
    required: ['localizationId'],
  },
  handler: async ({ localizationId, confirm }, client) => {
    // Read first, so the confirmation prompt names the locale being destroyed.
    const localization = await fetchLocalization(client, localizationId).catch(() => null);
    const locale = localization?.attributes?.locale ?? '(unknown locale)';

    if (!confirm) {
      return `⚠️ Refusing to delete localization ${localizationId} (${locale}) without confirmation.

This removes the whole listing for that language, plus its screenshot sets and
app preview sets. Re-run with confirm: true to proceed.`;
    }

    await client.delete(`/v1/appStoreVersionLocalizations/${localizationId}`);

    return `🗑️ Localization ${locale} (${localizationId}) deleted, along with its screenshots and previews.`;
  },
});

export const localizationTools: Tool[] = [
  listLocalizations,
  getLocalization,
  listSupportedLocales,
  diagnoseLocalizations,
  createLocalization,
  deleteLocalization,
];
