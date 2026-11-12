import { resolveRemnawaveRouteMode, type RuntimeConfig } from '../runtime/config.js';
import { buildRemnawaveApiToolDiscoveryDescription } from '../remnawave-api/contract.js';
import { RuntimeConfigError } from '../runtime/errors.js';

export interface ToolDefinition {
  readonly kind: 'tool';
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

export interface DiscoveryManifest {
  readonly tools: readonly ToolDefinition[];
}

export interface ServerDefinition {
  readonly manifest: DiscoveryManifest;
  readonly capabilities: {
    readonly tools: { readonly listChanged: false };
  };
}

export const STABLE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    kind: 'tool',
    name: 'remnawave_api',
    title: 'Remnawave API',
    description: buildRemnawaveApiToolDiscoveryDescription(),
  },
  // Fork (split read/write): same router behind a read-only entry and a write entry.
  { kind: 'tool', name: 'remnawave_read', title: 'Remnawave API (read)', description: 'Read-only entry: discovery, describe and read operations; writes are refused.' },
  { kind: 'tool', name: 'remnawave_write', title: 'Remnawave API (write)', description: 'Write entry: write operations behind confirmation tokens; reads work too.' },
] as const;

const PRIMARY_TOOL_DEFINITION: ToolDefinition = STABLE_TOOL_DEFINITIONS[0];

const EMPTY_DISCOVERY: DiscoveryManifest = {
  tools: [],
};

export function buildDiscoveryManifest(config: RuntimeConfig): DiscoveryManifest {
  ensureDiscoveryGating(config);

  return {
    // remnawave_read / remnawave_write are registered next to it (server.ts); the manifest keeps the primary tool only.
    tools: [primaryToolDefinition(config)],
  };
}

function primaryToolDefinition(config: RuntimeConfig): ToolDefinition {
  const routeMode = resolveRemnawaveRouteMode(config);
  if (routeMode === 'openapi-3.4.4') {
    return { ...PRIMARY_TOOL_DEFINITION, description: 'Remnawave 3.4.4 API. Send domain to discover operations, domain and operation to describe, and add payload to execute. Writes require a confirmation token.' };
  }
  if (routeMode === 'auto') {
    return { ...PRIMARY_TOOL_DEFINITION, description: 'Remnawave API with the contract picked from the panel version (/api/system/metadata: 2.x -> 2.8.1, 3.x -> 3.4.4). Send domain to discover operations, domain and operation to describe, and add payload to execute. Writes require a confirmation token.' };
  }
  return PRIMARY_TOOL_DEFINITION;
}

export function buildServerDefinition(config: RuntimeConfig): ServerDefinition {
  const manifest = buildDiscoveryManifest(config);

  return {
    manifest,
    capabilities: {
      tools: { listChanged: false },
    },
  };
}

export function registerDiscoverySurface(server: ServerDefinition): DiscoveryManifest {
  return {
    tools: [...server.manifest.tools],
  };
}

export function listDiscoveryCapabilities(server: ServerDefinition): DiscoveryManifest {
  return registerDiscoverySurface(server);
}

export function buildDisabledDiscoveryManifest(): DiscoveryManifest {
  return EMPTY_DISCOVERY;
}

function ensureDiscoveryGating(config: RuntimeConfig): void {
  const { remnawaveVersion } = config.startupDiagnostics;

  if (remnawaveVersion.status === 'unsupported') {
    throw new RuntimeConfigError(
      'version',
      'REMNAWAVE_VERSION_UNSUPPORTED',
      'Unsupported Remnawave version cannot advertise the planned discovery surface.',
      { remnawaveVersion: remnawaveVersion.value },
    );
  }

  if (remnawaveVersion.status === 'unknown') {
    throw new RuntimeConfigError(
      'version',
      'REMNAWAVE_VERSION_UNKNOWN',
      'Unknown Remnawave version cannot advertise the planned discovery surface.',
    );
  }
}
