import { MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { RuntimeConfigError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface StartupDiagnostics {
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly protocolVersion: string;
  };
  readonly transport: 'stdio';
  readonly remnawaveVersion: {
    readonly supported: boolean;
    readonly status: 'supported' | 'unsupported' | 'unknown';
    readonly value: string | null;
    readonly supportedRange?: string;
  };
  readonly capabilities: {
    readonly tools: boolean;
  };
}

export interface RuntimeConfig {
  readonly remnawaveBaseUrl: string;
  readonly remnawaveApiToken: string;
  readonly logLevel: LogLevel;
  readonly startupDiagnostics: StartupDiagnostics;
}

const SUPPORTED_REMNAWAVE_VERSIONS = new Set(['3.3.2', '3.4.4']);
// Fork (whoiam): one binary serves a 2.8.x panel and a 3.4.x panel. These values are accepted as a gate only;
// the contract is picked per panel from GET /api/system/metadata (2.x -> pinned 2.8.1 OpenAPI, 3.x -> pinned 3.4.4).
const AUTO_DETECT_REMNAWAVE_VERSION = /^(auto|2\.[78]\.\d+|3\.\d+\.\d+)$/;
const SUPPORTED_REMNAWAVE_RANGE = '3.3.2, 3.4.4';

export type RemnawaveRouteMode = 'legacy-3.3.2' | 'openapi-3.4.4' | 'auto';

/** Which router serves the tools: the exact upstream pins keep upstream behaviour, anything else probes the panel. */
export function resolveRemnawaveRouteMode(config: RuntimeConfig): RemnawaveRouteMode {
  const value = config.startupDiagnostics.remnawaveVersion.value;
  if (value === '3.3.2') return 'legacy-3.3.2';
  if (value === '3.4.4') return 'openapi-3.4.4';
  return 'auto';
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const remnawaveBaseUrl = readRequiredEnv(env, 'REMNAWAVE_BASE_URL');
  const remnawaveApiToken = readRequiredEnv(env, 'REMNAWAVE_API_TOKEN');
  const remnawaveVersion = classifyRemnawaveVersion(env.REMNAWAVE_VERSION);

  return {
    remnawaveBaseUrl,
    remnawaveApiToken,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    startupDiagnostics: {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      transport: 'stdio',
      remnawaveVersion,
      capabilities: {
        tools: remnawaveVersion.supported,
      },
    },
  };
}






function readRequiredEnv(
  env: NodeJS.ProcessEnv,
  key: 'REMNAWAVE_BASE_URL' | 'REMNAWAVE_API_TOKEN',
): string {
  const value = env[key]?.trim();

  if (value) {
    return value;
  }

  if (key === 'REMNAWAVE_BASE_URL') {
    throw new RuntimeConfigError(
      'config',
      'REMNAWAVE_BASE_URL_MISSING',
      'Missing required environment variable: REMNAWAVE_BASE_URL',
      { envVar: key },
    );
  }

  throw new RuntimeConfigError(
    'config',
    'REMNAWAVE_API_TOKEN_MISSING',
    'Missing required environment variable: REMNAWAVE_API_TOKEN',
    { envVar: key },
  );
}

function classifyRemnawaveVersion(rawValue: string | undefined): StartupDiagnostics['remnawaveVersion'] {
  const value = rawValue?.trim();

  if (!value) {
    return {
      supported: false,
      status: 'unknown',
      value: null,
      supportedRange: SUPPORTED_REMNAWAVE_RANGE,
    };
  }

  if (SUPPORTED_REMNAWAVE_VERSIONS.has(value) || AUTO_DETECT_REMNAWAVE_VERSION.test(value)) {
    return {
      supported: true,
      status: 'supported',
      value,
      supportedRange: SUPPORTED_REMNAWAVE_RANGE,
    };
  }

  return {
    supported: false,
    status: 'unsupported',
    value,
    supportedRange: SUPPORTED_REMNAWAVE_RANGE,
  };
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }

  return 'info';
}
