/**
 * TestFlight beta groups and testers.
 */

import { defineTool, type Tool } from './types.js';
import type { AppStoreClient } from '../appstore-client.js';

interface BetaGroupSummary {
  id: string;
  name?: string;
  isInternalGroup?: boolean;
  publicLink?: string;
  publicLinkEnabled?: boolean;
  publicLinkLimit?: number;
  publicLinkLimitEnabled?: boolean;
  createdDate?: string;
  testerCount?: number;
}

function formatDate(value?: string): string {
  if (!value) return 'unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().split('T')[0];
}

/**
 * Read every beta group of an app. Written here rather than reusing
 * `client.listBetaGroups`, which fetches a single page (Apple's default limit is
 * 50) and drops the tester count.
 */
async function fetchBetaGroups(client: AppStoreClient, appId: string): Promise<BetaGroupSummary[]> {
  const { data } = await client.getAllPages(`/v1/apps/${appId}/betaGroups`, {
    query: { limit: 200 },
  });

  return data.map((group: any): BetaGroupSummary => {
    const attributes = group.attributes ?? {};

    return {
      id: group.id,
      name: attributes.name,
      isInternalGroup: attributes.isInternalGroup,
      publicLink: attributes.publicLink,
      publicLinkEnabled: attributes.publicLinkEnabled,
      publicLinkLimit: attributes.publicLinkLimit,
      publicLinkLimitEnabled: attributes.publicLinkLimitEnabled,
      createdDate: attributes.createdDate,
      testerCount: group.relationships?.betaTesters?.meta?.paging?.total,
    };
  });
}

/**
 * One block per group. Optional lines are pushed conditionally instead of being
 * interpolated inline: a template literal with `${cond ? x : ''}` on its own
 * line leaves a stray whitespace-only line when the condition is false.
 */
function formatBetaGroup(group: BetaGroupSummary, index: number): string {
  const lines = [
    `${index + 1}. ${group.name ?? '(unnamed group)'}`,
    `   • Group ID: ${group.id}`,
    `   • Type: ${group.isInternalGroup ? 'Internal' : 'External'}`,
  ];

  if (typeof group.testerCount === 'number') {
    lines.push(`   • Testers: ${group.testerCount}`);
  }

  if (group.publicLinkEnabled && group.publicLink) {
    lines.push(`   • Public link: ${group.publicLink}`);
    if (group.publicLinkLimitEnabled && typeof group.publicLinkLimit === 'number') {
      lines.push(`   • Public link limit: ${group.publicLinkLimit} tester(s)`);
    }
  } else if (!group.isInternalGroup) {
    lines.push('   • Public link: disabled');
  }

  lines.push(`   • Created: ${formatDate(group.createdDate)}`);

  return lines.join('\n');
}

export const listBetaGroups = defineTool<{ appId: string }>({
  name: 'list_beta_groups',
  description: 'List all TestFlight beta groups for an app',
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
    const groups = await fetchBetaGroups(client, appId);

    if (groups.length === 0) {
      return `No TestFlight beta group found for app ${appId}.`;
    }

    return `🧪 TestFlight beta groups for app ${appId} (${groups.length}):

${groups.map(formatBetaGroup).join('\n\n')}`;
  },
});

export const addTesterToBetaGroup = defineTool<{
  groupId: string;
  email: string;
  firstName?: string;
  lastName?: string;
}>({
  name: 'add_tester_to_beta_group',
  description: 'Add a tester to a TestFlight beta group',
  inputSchema: {
    type: 'object',
    properties: {
      groupId: {
        type: 'string',
        description: 'The ID of the beta group',
      },
      email: {
        type: 'string',
        description: 'Email address of the tester',
      },
      firstName: {
        type: 'string',
        description: 'First name of the tester (optional)',
      },
      lastName: {
        type: 'string',
        description: 'Last name of the tester (optional)',
      },
    },
    required: ['groupId', 'email'],
  },
  handler: async (args, client) => {
    const result = await client.addTesterToBetaGroup(args);
    const { firstName, lastName } = args;

    return `✅ ${result.message}
• Email: ${result.email}
• Group ID: ${result.groupId}
• Tester ID: ${result.testerId}
${firstName || lastName ? `• Name: ${firstName || ''} ${lastName || ''}` : ''}`;
  },
});

export const betaTools: Tool[] = [listBetaGroups, addTesterToBetaGroup];
