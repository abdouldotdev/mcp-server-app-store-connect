/**
 * App Store Connect MCP server — entry point.
 *
 * Transports:
 *  - stdio (default): the standard MCP transport for local clients. No socket
 *    is opened and stdout carries nothing but JSON-RPC frames.
 *  - http (TRANSPORT=http): optional Streamable HTTP transport, guarded so it
 *    can never be exposed unauthenticated beyond loopback.
 *
 * This file contains no tool logic. Tools live in `src/tools/` and are
 * discovered through the registry — see CONTRIBUTING.md.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { AppStoreClient } from './appstore-client.js';
import { assertRequiredEnv, getAppStoreConfig, getTransportMode } from './config.js';
import { logger } from './logger.js';
import { listToolDefinitions, toolsByName } from './tools/index.js';

dotenv.config();

const SERVER_NAME = 'appstore-connect-server';
const SERVER_VERSION = '2.0.0';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

/**
 * Build the MCP server. Tool registration is fully generic: adding a tool to
 * `src/tools/index.ts` is enough, nothing here needs to change.
 */
function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  const client = new AppStoreClient(getAppStoreConfig());

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);

    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const text = await tool.handler(args ?? {}, client);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Tool "${name}" failed: ${message}`);
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Default mode. One server instance bound to stdin/stdout, no listening socket.
 */
async function startStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout belongs to the protocol.
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (${toolsByName.size} tools).`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Optional mode, opt-in via TRANSPORT=http.
 *
 * Security invariant: the MCP routes are never reachable off-loopback without
 * authentication. With OAuth disabled, a non-loopback HOST requires
 * MCP_HTTP_TOKEN; otherwise the process refuses to start.
 */
async function startHttp(): Promise<void> {
  // Imported lazily so stdio runs never load Express and friends.
  const { HttpTransport } = await import('./transport/HttpTransport.js');

  const host = (process.env.HOST || '127.0.0.1').trim();
  const port = parseInt(process.env.PORT || '3001', 10);
  const oauthEnabled = process.env.OAUTH_ENABLED === 'true';
  const staticToken = process.env.MCP_HTTP_TOKEN?.trim() || undefined;
  const isLoopback = LOOPBACK_HOSTS.has(host);

  if (!oauthEnabled && !staticToken && !isLoopback) {
    logger.error(
      `Refusing to start: HTTP transport bound to "${host}" without authentication. ` +
        'Set OAUTH_ENABLED=true, or set MCP_HTTP_TOKEN, or bind HOST to 127.0.0.1.'
    );
    process.exit(1);
  }

  if (!oauthEnabled && !staticToken) {
    logger.warn(
      'HTTP transport running without authentication; restricted to loopback. ' +
        'Set MCP_HTTP_TOKEN or OAUTH_ENABLED=true before exposing it.'
    );
  }

  const transport = new HttpTransport({
    port,
    host,
    cors: {
      // No wildcard fallback: an unset CORS_ORIGIN means same-origin only.
      origin: process.env.CORS_ORIGIN || `http://${host}:${port}`,
      credentials: true,
    },
    staticToken,
    oauth: oauthEnabled
      ? {
          enabled: true,
          issuer: process.env.STYTCH_PROJECT_DOMAIN || 'https://test.stytch.com',
          audience: process.env.STYTCH_PROJECT_ID || 'default-audience',
          jwksUri:
            process.env.STYTCH_JWKS_URI ||
            `${process.env.STYTCH_PROJECT_DOMAIN || 'https://test.stytch.com'}/.well-known/jwks.json`,
        }
      : undefined,
  });

  transport.setMcpServerFactory(() => createMcpServer());

  await transport.start();
  logger.info(
    `${SERVER_NAME} v${SERVER_VERSION} ready on http (${toolsByName.size} tools, auth: ${
      oauthEnabled ? 'oauth' : staticToken ? 'bearer token' : 'none/loopback'
    }).`
  );

  const shutdown = async () => {
    await transport.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  assertRequiredEnv();

  const mode = getTransportMode();
  if (mode === 'http') {
    await startHttp();
  } else {
    await startStdio();
  }
}

// Only auto-start when executed directly, so the factory stays importable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error('Server crashed:', error);
    process.exit(1);
  });
}

export { createMcpServer };
