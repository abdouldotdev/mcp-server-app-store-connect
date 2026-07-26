/**
 * The single contract every tool in this server implements.
 *
 * Adding a tool means writing one object of this shape and adding it to the
 * array in `src/tools/index.ts`. The dispatcher in `src/index.ts` never needs
 * to change.
 */

import type { AppStoreClient } from '../appstore-client.js';

export interface Tool<TArgs = any> {
  /** Unique tool name exposed to MCP clients, snake_case (e.g. "list_apps"). */
  name: string;

  /** One-line description shown to the model. Say what it returns. */
  description: string;

  /** JSON Schema for the arguments object. Always `{ type: 'object', ... }`. */
  inputSchema: object;

  /**
   * Executes the tool and returns the text shown to the user.
   *
   * Throw on failure — the dispatcher catches, logs to stderr and returns an
   * MCP error result. `AppStoreApiError` messages already carry Apple's
   * `detail` string, so re-throwing is usually the right move.
   */
  handler: (args: TArgs, client: AppStoreClient) => Promise<string>;
}

/**
 * Identity helper that pins the argument type while keeping inference.
 * Purely for ergonomics — `const t: Tool<Args> = {...}` works just as well.
 */
export function defineTool<TArgs>(tool: Tool<TArgs>): Tool<TArgs> {
  return tool;
}
