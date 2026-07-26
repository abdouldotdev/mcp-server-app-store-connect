# Contributing

## Project layout

```
src/
  index.ts              Entry point: transport selection + generic MCP dispatcher.
                        Contains no tool logic — you should not need to touch it.
  config.ts             Env loading, credential validation, transport selection.
  logger.ts             stderr-only logger. Never use console.log (see below).
  appstore-client.ts    AppStoreClient: JWT auth, HTTP helpers, Apple error parsing.
  tools/
    types.ts            The Tool contract.
    index.ts            The registry — where you plug your tools in.
    apps.ts             Domain modules. Add a new file per new domain.
    versions.ts
    builds.ts
    beta.ts
    reports.ts
    pricing.ts
  transport/            Optional HTTP transport (TRANSPORT=http).
  auth/                 OAuth2 validation for the HTTP transport.
```

## The tool contract

```ts
export interface Tool<TArgs = any> {
  name: string;          // snake_case, unique across the whole server
  description: string;   // one line, says what it returns
  inputSchema: object;   // JSON Schema, always { type: 'object', ... }
  handler: (args: TArgs, client: AppStoreClient) => Promise<string>;
}
```

`handler` returns the plain text shown to the user. The dispatcher wraps it in
the MCP `content` envelope. Throw on failure — errors are caught, logged to
stderr and returned as an MCP error result.

## Adding a tool in two steps

**1. Write it** in a domain module under `src/tools/` (create the file if the
domain is new):

```ts
// src/tools/screenshots.ts
import { defineTool, type Tool } from './types.js';

export const listScreenshotSets = defineTool<{ localizationId: string }>({
  name: 'list_screenshot_sets',
  description: 'List screenshot sets for an app store version localization',
  inputSchema: {
    type: 'object',
    properties: {
      localizationId: {
        type: 'string',
        description: 'The ID of the app store version localization',
      },
    },
    required: ['localizationId'],
  },
  handler: async ({ localizationId }, client) => {
    const { data } = await client.getAllPages(
      `/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`
    );

    if (data.length === 0) return 'No screenshot sets found.';

    return data
      .map((set: any) => `• ${set.attributes.screenshotDisplayType} (${set.id})`)
      .join('\n');
  },
});

export const screenshotTools: Tool[] = [listScreenshotSets];
```

**2. Register it** in `src/tools/index.ts` — import the array and spread it:

```ts
import { screenshotTools } from './screenshots.js';

export const allTools: Tool[] = [
  ...appTools,
  // ...
  ...screenshotTools,   // <- add this line
];
```

That's it. `ListTools` and `CallTool` pick it up automatically. Duplicate tool
names throw at import time, so a collision between two parallel branches fails
loudly instead of silently shadowing.

## Using AppStoreClient

Build on the generic helpers rather than writing `fetch` calls:

```ts
await client.get('/v1/apps', { query: { limit: 200, 'filter[bundleId]': id } });
await client.post('/v1/appStoreVersions', { data: { /* ... */ } });
await client.patch(`/v1/appStoreVersions/${id}`, { data: { /* ... */ } });
await client.delete(`/v1/betaTesters/${id}`);

// Follows links.next automatically, returns every page merged.
const { data, included } = await client.getAllPages('/v1/apps/123/builds');
```

Query values that are arrays are comma-joined, as Apple's API expects
(`{ query: { 'fields[apps]': ['name', 'bundleId'] } }`).

Any non-2xx response throws `AppStoreApiError`, whose message already contains
Apple's `detail` string (the actionable one), the HTTP status and the endpoint.
It also exposes `.httpStatus`, `.code` and the raw `.errors` array if you need
to branch on a specific Apple error code. Do not catch and rewrap it with a
generic message — you would destroy the useful part.

## Logging

`stdout` is the MCP protocol channel in stdio mode. Writing anything else there
corrupts the protocol and disconnects the client.

- **Never** use `console.log`. Use `logger.debug/info/warn/error` from
  `src/logger.ts` — everything goes to stderr.
- **Never** log credentials, not even a prefix: no private key fragments, no Key
  ID, no Issuer ID. Use `redacted()` when you need to note presence.

## Before opening a PR

```bash
npm run build     # must pass with zero TypeScript errors
```

Then smoke-test over stdio: the server must answer `tools/list` and open no
listening socket.
