import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

import { RemnawaveClient } from './client/index.js';
import { resolveRemnawaveRouteMode, type RemnawaveRouteMode, type RuntimeConfig } from './runtime/config.js';
import { createStderrLogger } from './runtime/logger.js';
import { installProcessGuards } from './runtime/process-guard.js';
import { buildServerDefinition, registerDiscoverySurface, type DiscoveryManifest } from './server/discovery.js';

import { createRemnawaveApiClientAdapter } from './remnawave-api/client-adapter.js';
import { routeRemnawaveApiRequest } from './remnawave-api/router.js';
import { createPanelFamilyResolver, PanelVersionUnknownError } from './remnawave-api/panel-version.js';
import { DEFAULT_OPERATION_REGISTRY } from './remnawave-api/registry.js';
import { REMNAWAVE_V2_ROUTER, REMNAWAVE_V3_ROUTER, type OpenApiRouter } from './remnawave-api/v3.js';
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
  });
  const remnawaveApiClient = createRemnawaveApiClientAdapter(remnawaveClient);
  const remnawaveApiToolInput = z
    .object({
      domain: z.string().min(1),
      operation: z.string().min(1).optional(),
      // Fork: an object schema (string still accepted and parsed) so clients that fill free-form parameters
      // do not send the payload as a string; z.unknown() serialised to {} with no type.
      payload: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .optional()
        .describe('Operation payload as a JSON object. Use {} for operations that take no fields.'),
      responseMode: z.enum(['normalized', 'raw']).optional(),
      confirmToken: z.string().min(1).optional(),
    })
    .strict();
  type ToolArgs = z.infer<typeof remnawaveApiToolInput>;

  const routeMode = resolveRemnawaveRouteMode(config);
  const panelClient = { baseUrl: config.remnawaveBaseUrl, apiToken: config.remnawaveApiToken };
  const resolvePanelFamily = routeMode === 'auto' ? createPanelFamilyResolver(panelClient) : null;

  // Upstream pins: 3.3.2 = generated contract + typed client, 3.4.4 = pass-through OpenAPI router.
  // Fork auto mode: the panel's own metadata picks the pass-through router (2.x -> 2.8.1, 3.x -> 3.4.4).
  const selectRouter = async (): Promise<OpenApiRouter | 'legacy'> => {
    if (routeMode === 'legacy-3.3.2') return 'legacy';
    if (routeMode === 'openapi-3.4.4' || resolvePanelFamily === null) return REMNAWAVE_V3_ROUTER;
    const { family } = await resolvePanelFamily();
    return family === 'v2' ? REMNAWAVE_V2_ROUTER : REMNAWAVE_V3_ROUTER;
  };

  const toToolResult = (result: unknown) => {
    const safeResult = toJsonSafe(result);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(safeResult, null, 2) }],
      structuredContent: asStructuredContent(safeResult),
      ...(isCompactErrorEnvelope(safeResult) ? { isError: true } : {}),
    };
  };

  const runTool = async (rawArgs: ToolArgs, readOnly: boolean) => {
    const args = coercePayloadArgument(rawArgs);
    let router: OpenApiRouter | 'legacy';
    try {
      router = await selectRouter();
    } catch (error) {
      return toToolResult({
        error: {
          code: 'PANEL_VERSION_UNKNOWN',
          kind: 'upstream',
          message: error instanceof PanelVersionUnknownError ? error.message : 'Remnawave panel version could not be detected.',
          retryable: true,
        },
      });
    }

    // Fork (split read/write): discovery and describe (no payload) work on both tools; executing a
    // write-classified or unknown operation through remnawave_read is refused before any request is sent.
    if (readOnly && typeof args.operation === 'string' && Object.hasOwn(args, 'payload')) {
      const domain = args.domain.trim();
      const operation = args.operation.trim();
      const access = router === 'legacy'
        ? DEFAULT_OPERATION_REGISTRY.describeOperation(domain, operation)
        : router.describeAccess(domain, operation);
      if (access === null || access.write) {
        return toToolResult({
          error: {
            code: 'READ_ONLY_TOOL',
            kind: 'validation',
            message: `remnawave_read executes read operations only; ${domain}.${operation} is ${access === null ? 'unknown' : 'a write operation'} — use remnawave_write.`,
            retryable: false,
          },
        });
      }
    }

    const result = router === 'legacy'
      ? await routeRemnawaveApiRequest(args, remnawaveApiClient)
      : await router.route(args, panelClient);
    return toToolResult(result);
  };

  const primaryDescription = describePrimaryTool(routeMode);
  mcpServer.registerTool(
    'remnawave_api',
    {
      title: 'Remnawave API',
      description: primaryDescription,
      inputSchema: remnawaveApiToolInput,
    },
    async (args) => runTool(args, false),
  );
  mcpServer.registerTool(
    'remnawave_read',
    {
      title: 'Remnawave API (read)',
      description: `Read-only entry. ${primaryDescription} Executing a write operation here is refused.`,
      inputSchema: remnawaveApiToolInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => runTool(args, true),
  );
  mcpServer.registerTool(
    'remnawave_write',
    {
      title: 'Remnawave API (write)',
      description: `Write entry. ${primaryDescription} Reads work here too.`,
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

export function describePrimaryTool(routeMode: RemnawaveRouteMode): string {
  if (routeMode === 'openapi-3.4.4') {
    return 'Remnawave 3.4.4 API. Use domain only to discover operations, domain + operation to describe, and domain + operation + payload to execute. Writes require confirmation.';
  }
  if (routeMode === 'auto') {
    return 'Remnawave API; the contract follows the panel version from /api/system/metadata (2.x -> 2.8.1, 3.x -> 3.4.4; 3.x users are addressed by numeric id). Use domain only to discover operations, domain + operation to describe, and domain + operation + payload to execute. Path and query parameters are top-level payload fields; JSON bodies go in payload.body. Writes require confirmation.';
  }
  return 'Single Remnawave API entry point. Use domain only to discover operations, domain + operation to describe one operation, and domain + operation + payload to execute.';
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
