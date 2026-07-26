/**
 * Tools for App Store versions and their localized metadata.
 */

import { defineTool, type Tool } from './types.js';

export const createAppStoreVersion = defineTool<{
  appId: string;
  platform: string;
  versionString: string;
  copyright?: string;
  releaseType?: string;
  earliestReleaseDate?: string;
  buildId?: string;
}>({
  name: 'create_app_store_version',
  description: 'Create a new app store version for an app',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The ID of the app',
      },
      platform: {
        type: 'string',
        description: 'The platform (IOS, MAC_OS, TV_OS, VISION_OS)',
        enum: ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'],
      },
      versionString: {
        type: 'string',
        description: 'Version string in format X.Y or X.Y.Z (e.g., "1.0" or "1.0.0")',
      },
      copyright: {
        type: 'string',
        description: 'Copyright text for this version (optional)',
      },
      releaseType: {
        type: 'string',
        description: 'How the app should be released (optional)',
        enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'],
      },
      earliestReleaseDate: {
        type: 'string',
        description: 'ISO 8601 date string for scheduled release (required when releaseType is SCHEDULED)',
      },
      buildId: {
        type: 'string',
        description: 'ID of the build to associate with this version (optional)',
      },
    },
    required: ['appId', 'platform', 'versionString'],
  },
  handler: async (args, client) => {
    const version = await client.createAppStoreVersion(args);

    return `✅ App Store Version Created Successfully:
• Version: ${version.versionString}
• Platform: ${version.platform}
• State: ${version.appStoreState}
• Release Type: ${version.releaseType || 'MANUAL'}
• Version ID: ${version.id}
${version.earliestReleaseDate ? `• Scheduled Release: ${version.earliestReleaseDate}` : ''}
${version.copyright ? `• Copyright: ${version.copyright}` : ''}
• Created: ${new Date(version.createdDate).toLocaleString()}`;
  },
});

export const listAppStoreVersions = defineTool<{ appId: string }>({
  name: 'list_app_store_versions',
  description: 'List all app store versions for an app',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The ID of the app',
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId }, client) => {
    const versions = await client.listAppStoreVersions(appId);

    if (versions.length === 0) {
      return `No app store versions found for app ID: ${appId}`;
    }

    return `📱 App Store Versions for App ${appId}:

${versions
  .map(
    (version, index) =>
      `${index + 1}. Version ${version.versionString}
   • Platform: ${version.platform}
   • State: ${version.appStoreState}
   • Release Type: ${version.releaseType || 'MANUAL'}
   • Version ID: ${version.id}
   ${version.earliestReleaseDate ? `• Scheduled: ${new Date(version.earliestReleaseDate).toLocaleDateString()}` : ''}
   ${version.copyright ? `• Copyright: ${version.copyright}` : ''}
   • Created: ${new Date(version.createdDate).toLocaleDateString()}`
  )
  .join('\n\n')}`;
  },
});

export const updateAppStoreVersionLocalization = defineTool<{
  versionId: string;
  locale: string;
  description?: string;
  keywords?: string;
  whatsNew?: string;
  promotionalText?: string;
  supportUrl?: string;
  marketingUrl?: string;
}>({
  name: 'update_app_store_version_localization',
  description: "Update app store version localization (descriptions, keywords, what's new)",
  inputSchema: {
    type: 'object',
    properties: {
      versionId: {
        type: 'string',
        description: 'The ID of the app store version',
      },
      locale: {
        type: 'string',
        description: 'The locale code (e.g., "en-US", "es-ES", "fr-FR")',
      },
      description: {
        type: 'string',
        description: 'App description for this locale (4000 chars max)',
      },
      keywords: {
        type: 'string',
        description: 'Keywords for app store search (100 chars max)',
      },
      whatsNew: {
        type: 'string',
        description: "Release notes / what's new text (4000 chars max)",
      },
      promotionalText: {
        type: 'string',
        description: 'Promotional text (170 chars max)',
      },
      supportUrl: {
        type: 'string',
        description: 'Support URL for this locale',
      },
      marketingUrl: {
        type: 'string',
        description: 'Marketing URL for this locale',
      },
    },
    required: ['versionId', 'locale'],
  },
  handler: async (args, client) => {
    const localization = await client.updateAppStoreVersionLocalization(args);
    const { versionId, locale, description, keywords, whatsNew, promotionalText, supportUrl, marketingUrl } =
      args;

    return `✅ App Store Version Localization Updated:
• Version ID: ${versionId}
• Locale: ${locale}
• Localization ID: ${localization.id}
${description ? `• Description: ${description.substring(0, 100)}...` : ''}
${keywords ? `• Keywords: ${keywords}` : ''}
${whatsNew ? `• What's New: ${whatsNew.substring(0, 100)}...` : ''}
${promotionalText ? `• Promotional Text: ${promotionalText}` : ''}
${supportUrl ? `• Support URL: ${supportUrl}` : ''}
${marketingUrl ? `• Marketing URL: ${marketingUrl}` : ''}`;
  },
});

export const versionTools: Tool[] = [
  createAppStoreVersion,
  listAppStoreVersions,
  updateAppStoreVersionLocalization,
];
