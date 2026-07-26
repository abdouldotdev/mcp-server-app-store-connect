/**
 * Tools operating on apps themselves: listing, metadata, availability.
 */

import { defineTool, type Tool } from './types.js';

const appIdSchema = {
  type: 'object',
  properties: {
    appId: {
      type: 'string',
      description: 'The App Store Connect app ID',
    },
  },
  required: ['appId'],
};

export const listApps = defineTool<Record<string, never>>({
  name: 'list_apps',
  description: 'List all apps in App Store Connect',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, client) => {
    const apps = await client.listApps();

    return `Found ${apps.length} apps:\n\n${apps
      .map(
        (app) =>
          `• ${app.name} (${app.bundleId})\n  Status: ${app.status}\n  App Store ID: ${app.appStoreId || 'N/A'}\n  Platform: ${app.platform || 'N/A'}`
      )
      .join('\n\n')}`;
  },
});

export const getAppInfo = defineTool<{ appId: string }>({
  name: 'get_app_info',
  description: 'Get detailed information about a specific app',
  inputSchema: appIdSchema,
  handler: async ({ appId }, client) => {
    const appInfo = await client.getAppInfo(appId);

    if (!appInfo) {
      return `App not found with ID: ${appId}`;
    }

    return `App Information:
• Name: ${appInfo.name}
• Bundle ID: ${appInfo.bundleId}
• App Store ID: ${appInfo.appStoreId || 'N/A'}
• Status: ${appInfo.status}
• Version: ${appInfo.version || 'N/A'}
• Platform: ${appInfo.platform || 'N/A'}`;
  },
});

export const getAppInfoDetails = defineTool<{ appId: string }>({
  name: 'get_app_info_details',
  description: 'Get detailed app info including categories and age rating',
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
    const details = await client.getAppInfoDetails(appId);

    if (!details) {
      return `No detailed info found for app ${appId}.`;
    }

    return `ℹ️  Detailed App Info for App ${appId}:

• App Store State: ${details.appStoreState}
• Age Rating: ${details.appStoreAgeRating}
${details.brazilAgeRating ? `• Brazil Age Rating: ${details.brazilAgeRating}` : ''}
${details.kidsAgeBand ? `• Kids Age Band: ${details.kidsAgeBand}` : ''}

Categories:
• Primary Category ID: ${details.primaryCategory || 'Not set'}
${details.primarySubcategoryOne ? `• Primary Subcategory 1: ${details.primarySubcategoryOne}` : ''}
${details.primarySubcategoryTwo ? `• Primary Subcategory 2: ${details.primarySubcategoryTwo}` : ''}
${details.secondaryCategory ? `• Secondary Category: ${details.secondaryCategory}` : ''}
${details.secondarySubcategoryOne ? `• Secondary Subcategory 1: ${details.secondarySubcategoryOne}` : ''}
${details.secondarySubcategoryTwo ? `• Secondary Subcategory 2: ${details.secondarySubcategoryTwo}` : ''}`;
  },
});

export const getAppAvailability = defineTool<{ appId: string }>({
  name: 'get_app_availability',
  description: 'Get app availability information',
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
    const availability = await client.getAppAvailability(appId);

    if (!availability) {
      return `No availability information found for app ${appId}.`;
    }

    return `🌍 App Availability for App ${appId}:

• Available in New Territories: ${availability.availableInNewTerritories ? 'Yes' : 'No'}

Available Territories:
${
  availability.territories.length === 0
    ? 'All territories'
    : availability.territories
        .map((territory: any, index: number) => `${index + 1}. ${territory}`)
        .join('\n')
}`;
  },
});

export const appTools: Tool[] = [listApps, getAppInfo, getAppInfoDetails, getAppAvailability];
