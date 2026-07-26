/**
 * Tools for builds uploaded to App Store Connect / TestFlight.
 *
 * A note on naming, because the API is actively misleading here: on the `builds`
 * resource, `attributes.version` is the *build number* (CFBundleVersion) — there
 * is no `attributes.build`. The marketing version (CFBundleShortVersionString)
 * lives on the related `preReleaseVersion`, so it has to be included explicitly.
 *
 * The collection is read through `/v1/builds?filter[app]=` rather than
 * `/v1/apps/{id}/builds`: the latter rejects both `include` and `sort`
 * (`400 PARAMETER_ERROR.ILLEGAL`), so it can neither resolve the marketing
 * version nor return the newest build first.
 */

import { defineTool, type Tool } from './types.js';
import type { AppStoreClient } from '../appstore-client.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

interface BuildSummary {
  id: string;
  buildNumber?: string;
  marketingVersion?: string;
  processingState?: string;
  uploadedDate?: string;
  expired?: boolean;
  expirationDate?: string;
  audienceType?: string;
}

function formatDate(value?: string): string {
  if (!value) return 'unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().split('T')[0];
}

/**
 * Fetch builds newest first, with the marketing version resolved from the
 * included `preReleaseVersions` resources.
 */
async function fetchBuilds(
  client: AppStoreClient,
  appId: string,
  limit: number
): Promise<BuildSummary[]> {
  const response = await client.get('/v1/builds', {
    query: {
      'filter[app]': appId,
      sort: '-uploadedDate',
      limit,
      include: 'preReleaseVersion',
      'fields[builds]': [
        'version',
        'uploadedDate',
        'expirationDate',
        'expired',
        'processingState',
        'buildAudienceType',
        'preReleaseVersion',
      ],
      'fields[preReleaseVersions]': ['version', 'platform'],
    },
  });

  const included: any[] = response?.included ?? [];
  const marketingVersions = new Map<string, string>();
  for (const entry of included) {
    if (entry?.type === 'preReleaseVersions') {
      marketingVersions.set(entry.id, entry.attributes?.version);
    }
  }

  const data: any[] = response?.data ?? [];

  return data.map((build): BuildSummary => {
    const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;

    return {
      id: build.id,
      buildNumber: build.attributes?.version,
      marketingVersion: preReleaseId ? marketingVersions.get(preReleaseId) : undefined,
      processingState: build.attributes?.processingState,
      uploadedDate: build.attributes?.uploadedDate,
      expired: build.attributes?.expired,
      expirationDate: build.attributes?.expirationDate,
      audienceType: build.attributes?.buildAudienceType,
    };
  });
}

function formatBuild(build: BuildSummary, index: number): string {
  const title = build.marketingVersion
    ? `${build.marketingVersion} (build ${build.buildNumber ?? '?'})`
    : `build ${build.buildNumber ?? '?'}`;

  const lines = [
    `${index + 1}. ${title}`,
    `   • Processing state: ${build.processingState ?? 'unknown'}`,
    `   • Uploaded: ${formatDate(build.uploadedDate)}`,
  ];

  if (build.expired) {
    lines.push(`   • ⚠️ Expired on ${formatDate(build.expirationDate)} — no longer testable`);
  } else if (build.expirationDate) {
    lines.push(`   • Expires: ${formatDate(build.expirationDate)}`);
  }

  if (build.audienceType) {
    lines.push(`   • Audience: ${build.audienceType}`);
  }

  lines.push(`   • Build ID: ${build.id}`);

  return lines.join('\n');
}

export const getBuilds = defineTool<{ appId: string; limit?: number }>({
  name: 'get_builds',
  description:
    'List the builds uploaded for an app (TestFlight / App Store), newest first, with their marketing version, build number, processing state and expiry.',
  inputSchema: {
    type: 'object',
    properties: {
      appId: {
        type: 'string',
        description: 'The App Store Connect app ID',
      },
      limit: {
        type: 'number',
        description: `Maximum number of builds to return, 1-${MAX_LIMIT} (default: ${DEFAULT_LIMIT})`,
      },
    },
    required: ['appId'],
  },
  handler: async ({ appId, limit }, client) => {
    const capped = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const builds = await fetchBuilds(client, appId, capped);

    if (builds.length === 0) {
      return `No build has been uploaded for app ${appId}.`;
    }

    return `Builds for app ${appId} (${builds.length}, newest first):

${builds.map(formatBuild).join('\n\n')}`;
  },
});

export const buildTools: Tool[] = [getBuilds];
