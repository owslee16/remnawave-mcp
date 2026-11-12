import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { RemnawaveClient } from './client/index.js';
import type { RuntimeConfig } from './runtime/config.js';
import { createStderrLogger } from './runtime/logger.js';
import { installProcessGuards } from './runtime/process-guard.js';
import { buildServerDefinition, registerDiscoverySurface, type DiscoveryManifest } from './server/discovery.js';

import { createRemnawaveApiClientAdapter } from './remnawave-api/client-adapter.js';
import { routeRemnawaveApiRequest } from './remnawave-api/router.js';
import { DEFAULT_OPERATION_REGISTRY } from './remnawave-api/registry.js';
export interface ServerRuntime {
  readonly close: () => Promise<void>;
  readonly discovery: DiscoveryManifest;
}

export async function startServer(config: RuntimeConfig): Promise<ServerRuntime> {
  const logger = createStderrLogger(config.logLevel);
  const server = buildServerDefinition(config);
  const discovery = registerDiscoverySurface(server);
  const mcpServer = new McpServer(
    {
      name: config.startupDiagnostics.server.name,
      version: config.startupDiagnostics.server.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  const remnawaveClient = new RemnawaveClient({
    baseUrl: config.remnawaveBaseUrl,
    apiToken: config.remnawaveApiToken,
    // Same binary serves 2.x and 3.x panels: detect the major once from /api/system/metadata.
    panelMajor: 'auto',
  });
  const remnawaveApiClient = createRemnawaveApiClientAdapter(remnawaveClient);
  const remnawaveApiToolInput = z
    .object({
      domain: z.string().min(1),
      operation: z.string().min(1).optional(),
      payload: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .optional()
        .describe('Operation payload as a JSON object. Use {} for operations that take no fields.'),
      responseMode: z.enum(['normalized', 'raw']).optional(),
      confirmToken: z.string().min(1).optional(),
    })
    .strict();

  mcpServer.registerTool(
    'remnawave_api',
    {
      title: 'Remnawave API',
      description: 'Single Remnawave API entry point. Use domain only to discover operations, domain + operation to describe one operation, and domain + operation + payload to execute.',
      inputSchema: remnawaveApiToolInput,
    },
    async (args) => {
      const result = await routeRemnawaveApiRequest(coercePayloadArgument(args), remnawaveApiClient);
      const safeResult = toJsonSafe(result);
      return {
        content: [{ type: 'text', text: JSON.stringify(safeResult, null, 2) }],
        structuredContent: asStructuredContent(safeResult),
        ...(isCompactErrorEnvelope(safeResult) ? { isError: true } : {}),
      };
    },
  );
  // Platform split (ai_agents, 2026-10-28): the same router behind two tools so an MCP client can grant reads
  // without a confirmation gate and keep writes behind one (readOnlyHint annotations). Discovery and describe
  // calls (no payload) are allowed on both; executing a write-classified operation through remnawave_read is refused.
  const runTool = async (args: z.infer<typeof remnawaveApiToolInput>, readOnly: boolean) => {
    const coerced = coercePayloadArgument(args);
    if (readOnly && coerced.operation && Object.hasOwn(coerced, 'payload')) {
      const meta = DEFAULT_OPERATION_REGISTRY.describeOperation(coerced.domain, coerced.operation);
      if (meta === null || meta.write) {
        const safeResult = {
          error: {
            code: 'READ_ONLY_TOOL',
            kind: 'validation',
            message: `remnawave_read executes read operations only; ${coerced.domain}.${coerced.operation} is a write operation — use remnawave_write.`,
            retryable: false,
          },
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(safeResult, null, 2) }], structuredContent: safeResult, isError: true };
      }
    }
    const result = await routeRemnawaveApiRequest(coerced, remnawaveApiClient);
    const safeResult = toJsonSafe(result);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(safeResult, null, 2) }],
      structuredContent: asStructuredContent(safeResult),
      ...(isCompactErrorEnvelope(safeResult) ? { isError: true } : {}),
    };
  };
  mcpServer.registerTool(
    'remnawave_read',
    {
      title: 'Remnawave API (read)',
      description: 'Remnawave reads only: domain only to discover operations, domain + operation to describe one, domain + operation + payload to execute a read-classified operation. Writes are refused.',
      inputSchema: remnawaveApiToolInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => runTool(args, true),
  );
  mcpServer.registerTool(
    'remnawave_write',
    {
      title: 'Remnawave API (write)',
      description: 'Remnawave writes: domain + operation + payload for write-classified operations (confirm and preview/apply tokens apply). Reads work here too.',
      inputSchema: remnawaveApiToolInput,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => runTool(args, false),
  );
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    logger.info('shutdown', { reason: 'stdin_closed' });
    process.exit(0);
  };
  transport.onerror = (error) => {
    logger.error('transport_error', { message: error.message });
    process.exitCode = 1;
  };

  installProcessGuards(logger);
  logger.info('startup', {
    ...config.startupDiagnostics,
    discovery: {
      tools: discovery.tools.map((tool) => tool.name),
    },
  });
  await mcpServer.connect(transport);

  return {
    discovery,
    close: async () => {
      await mcpServer.close();
      logger.info('shutdown', { reason: 'runtime_closed' });
    },
  };
}

function coercePayloadArgument<T extends { payload?: unknown }>(args: T): T {
  if (typeof args.payload !== 'string') {
    return args;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args.payload);
  } catch {
    return args;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return args;
  }

  return { ...args, payload: parsed };
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonSafe(item)]);
    return Object.fromEntries(entries);
  }

  return value;
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value,
  };
}

function isCompactErrorEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const error = (value as Record<string, unknown>).error;
  return Boolean(error && typeof error === 'object' && !Array.isArray(error));
}
