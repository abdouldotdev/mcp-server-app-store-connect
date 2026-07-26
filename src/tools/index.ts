/**
 * Tool registry.
 *
 * === HOW TO ADD A TOOL ===
 * 1. Create (or open) a domain module in this folder, e.g. `screenshots.ts`.
 * 2. Export a `Tool` via `defineTool({ name, description, inputSchema, handler })`
 *    and collect the module's tools in an exported array.
 * 3. Import that array here and spread it into `allTools` below.
 * Nothing else needs to change — the dispatcher in `src/index.ts` is generic.
 *
 * See CONTRIBUTING.md for a full worked example.
 */

import type { Tool } from './types.js';
import { appTools } from './apps.js';
import { versionTools } from './versions.js';
import { buildTools } from './builds.js';
import { betaTools } from './beta.js';
import { reportTools } from './reports.js';
import { pricingTools } from './pricing.js';
import { screenshotTools } from './screenshots.js';
import { localizationTools } from './localizations.js';
import { submissionTools } from './submission.js';
import { reviewResponseTools } from './reviewResponses.js';
import { pricingWriteTools } from './pricingWrite.js';
import { provisioningTools } from './provisioning.js';

export type { Tool } from './types.js';
export { defineTool } from './types.js';

/** Every tool exposed by this server. Register new domain arrays here. */
export const allTools: Tool[] = [
  ...appTools,
  ...versionTools,
  ...buildTools,
  ...betaTools,
  ...reportTools,
  ...pricingTools,
  ...screenshotTools,
  ...localizationTools,
  ...submissionTools,
  ...reviewResponseTools,
  ...pricingWriteTools,
  ...provisioningTools,
];

/**
 * Name -> tool lookup used by the CallTool dispatcher.
 * Throws at import time on duplicate names, so a collision between two
 * parallel contributions fails loudly instead of silently shadowing.
 */
export const toolsByName: Map<string, Tool> = (() => {
  const map = new Map<string, Tool>();

  for (const tool of allTools) {
    if (map.has(tool.name)) {
      throw new Error(`Duplicate tool name registered: "${tool.name}"`);
    }
    map.set(tool.name, tool);
  }

  return map;
})();

/** MCP `ListTools` payload derived from the registry. */
export function listToolDefinitions() {
  return allTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
