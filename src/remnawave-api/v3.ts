import { buildTier3ConfirmationState } from './risk.js';
import openApiDocument from './openapi/remnawave-openapi-3.4.4.json' with { type: 'json' };
import openApiDocument281 from './openapi/remnawave-openapi-2.8.1.json' with { type: 'json' };

interface Parameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly style?: string;
  readonly schema?: { readonly type?: string; readonly minimum?: number };
}

interface ApiOperation {
  readonly operationId: string;
  readonly summary?: string;
  readonly parameters?: readonly Parameter[];
  readonly requestBody?: { readonly required?: boolean; readonly content?: Record<string, unknown> };
}

interface V3Operation {
  readonly domain: string;
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly spec: ApiOperation;
}

interface V3Request {
  readonly domain?: unknown;
  readonly operation?: unknown;
  readonly payload?: unknown;
  readonly responseMode?: unknown;
  readonly confirmToken?: unknown;
}

interface V3ClientOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface OpenApiDocument {
  readonly paths: Record<string, Record<string, ApiOperation>>;
}

/** Pass-through router over one pinned Remnawave OpenAPI document (fork: shared by the 3.4.4 and 2.8.1 contracts). */
export interface OpenApiRouter {
  readonly version: string;
  /** null when the operation is unknown; write = any non-GET method. */
  readonly describeAccess: (domain: string, operation: string) => { readonly write: boolean } | null;
  readonly route: (request: V3Request, client: V3ClientOptions) => Promise<unknown>;
}

const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const excludedPrefixes = ['/api/auth', '/api/tokens', '/api/sub/', '/api/node-plugins', '/api/ip-control', '/api/keygen', '/api/system/tools/', '/api/remnawave-settings'];

function extractOperations(document: OpenApiDocument, version: string): readonly V3Operation[] {
  const extractedOperations: readonly V3Operation[] = Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem).flatMap(([method, spec]) => {
      if (!methods.has(method) || excludedPrefixes.some((prefix) => path.startsWith(prefix))) return [];
      const domain = path.split('/')[2]?.replaceAll('-', '_') ?? 'unknown';
      const operation = snakeCase(spec.operationId.split('_').slice(1).join('_'));
      return [{ domain, operation, method, path, spec }];
    }),
  );
  const counts = new Map<string, number>();
  for (const entry of extractedOperations) {
    const key = `${entry.domain}.${entry.operation}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const operations: readonly V3Operation[] = extractedOperations.map((entry) => ({
    ...entry,
    operation: (counts.get(`${entry.domain}.${entry.operation}`) ?? 0) > 1
      ? `${entry.operation}_${entry.path.split('/')[3] ?? entry.method}`
      : entry.operation,
  }));
  const operationNames = new Set<string>();
  for (const entry of operations) {
    const key = `${entry.domain}.${entry.operation}`;
    if (operationNames.has(key)) throw new Error(`Duplicate Remnawave ${version} operation: ${key}`);
    operationNames.add(key);
  }
  return operations;
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

function error(code: string, message: string, statusCode?: number): Record<string, unknown> {
  return { error: { code, kind: statusCode === undefined ? 'validation' : 'upstream', message, retryable: statusCode !== undefined && statusCode >= 500, ...(statusCode === undefined ? {} : { statusCode }) } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(entry: V3Operation): Record<string, unknown> {
  return {
    domain: entry.domain,
    operation: entry.operation,
    method: entry.method.toUpperCase(),
    path: entry.path,
    summary: entry.spec.summary ?? '',
    parameters: entry.spec.parameters ?? [],
    requestBody: entry.spec.requestBody ?? null,
    write: entry.method !== 'get',
    confirmationRequired: entry.method !== 'get',
    payloadFormat: 'Path and query parameters are top-level payload fields; JSON request bodies go in payload.body.',
  };
}

export function createOpenApiRouter(document: OpenApiDocument, version: string): OpenApiRouter {
  const operations = extractOperations(document, version);
  return {
    version,
    describeAccess: (domain, operation) => {
      const entry = operations.find((item) => item.domain === domain && item.operation === operation);
      return entry === undefined ? null : { write: entry.method !== 'get' };
    },
    route: (request, client) => routeOpenApiRequest(operations, version, request, client),
  };
}

export const REMNAWAVE_V3_ROUTER = createOpenApiRouter(openApiDocument as unknown as OpenApiDocument, '3.4.4');
export const REMNAWAVE_V2_ROUTER = createOpenApiRouter(openApiDocument281 as unknown as OpenApiDocument, '2.8.1');

export async function routeRemnawaveV3Request(request: V3Request, client: V3ClientOptions): Promise<unknown> {
  return REMNAWAVE_V3_ROUTER.route(request, client);
}

async function routeOpenApiRequest(
  operations: readonly V3Operation[],
  version: string,
  request: V3Request,
  client: V3ClientOptions,
): Promise<unknown> {
  const domain = typeof request.domain === 'string' ? request.domain.trim() : '';
  const operationName = typeof request.operation === 'string' ? request.operation.trim() : '';
  if (!domain) return error('DOMAIN_REQUIRED', 'domain is required.');
  if (request.responseMode !== undefined && request.responseMode !== 'normalized' && request.responseMode !== 'raw') {
    return error('INVALID_RESPONSE_MODE', 'responseMode must be normalized or raw.');
  }
  const domainOperations = operations.filter((entry) => entry.domain === domain);
  if (domainOperations.length === 0) return error('UNSUPPORTED_DOMAIN', `Unsupported domain: ${domain}.`);
  if (!operationName) {
    if (request.payload !== undefined) return error('OPERATION_REQUIRED', 'operation is required when payload is provided.');
    return { domain, version, operations: domainOperations.map((entry) => ({ operation: entry.operation, method: entry.method.toUpperCase(), path: entry.path, write: entry.method !== 'get' })) };
  }
  const entry = domainOperations.find((item) => item.operation === operationName);
  if (!entry) return error('UNSUPPORTED_OPERATION', `Unsupported operation: ${domain}.${operationName}.`);
  if (request.payload === undefined) return describe(entry);
  if (!isObject(request.payload)) return error('INVALID_PAYLOAD', 'payload must be an object.');

  const payload = request.payload;
  if (entry.method === 'get' && payload.body !== undefined) return error('BODY_NOT_ALLOWED', 'GET requests cannot contain payload.body.');
  const parameters = entry.spec.parameters ?? [];
  for (const parameter of parameters) {
    if (parameter.required && (payload[parameter.name] === undefined || payload[parameter.name] === null)) {
      return error('MISSING_PARAMETER', `Missing required parameter: ${parameter.name}.`);
    }
  }
  if (entry.spec.requestBody?.required && !isObject(payload.body)) {
    return error('BODY_REQUIRED', 'payload.body must contain a JSON request body.');
  }
  let path = entry.path;
  for (const parameter of parameters.filter((item) => item.in === 'path')) {
    const value = payload[parameter.name];
    if (typeof value !== 'string' && typeof value !== 'number') return error('INVALID_PATH_PARAMETER', `Invalid path parameter: ${parameter.name}.`);
    if (parameter.schema?.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value <= (parameter.schema.minimum ?? 0))) {
      return error('INVALID_PATH_PARAMETER', `Invalid numeric path parameter: ${parameter.name}.`);
    }
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  const query = new URLSearchParams();
  for (const parameter of parameters.filter((item) => item.in === 'query')) {
    const value = payload[parameter.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(parameter.name, typeof item === 'object' ? JSON.stringify(item) : String(item));
    } else if (isObject(value) && parameter.style === 'deepObject') {
      for (const [key, item] of Object.entries(value)) query.append(`${parameter.name}[${key}]`, String(item));
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query.set(parameter.name, String(value));
    } else return error('INVALID_QUERY_PARAMETER', `Invalid query parameter: ${parameter.name}.`);
  }
  if (query.size > 0) path += `?${query}`;

  if (entry.method !== 'get') {
    const confirmation = buildTier3ConfirmationState({
      domain,
      operation: operationName,
      effect: 'update',
      scope: 'bounded_set',
      blastRadius: 'mass_or_destructive',
      impactSummary: `${entry.method.toUpperCase()} ${entry.path}`,
      payload,
      confirmationToken: typeof request.confirmToken === 'string' ? request.confirmToken : null,
    });
    if (!confirmation.ok) return { error: { code: 'CONFIRMATION_REQUIRED', kind: 'confirmation_required', message: `Confirm ${entry.method.toUpperCase()} ${entry.path}.`, retryable: false, token: confirmation.token } };
  }

  try {
    const response = await (client.fetch ?? globalThis.fetch)(`${client.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: entry.method.toUpperCase(),
      headers: { Authorization: `Bearer ${client.apiToken}`, 'Content-Type': 'application/json' },
      body: payload.body === undefined ? undefined : JSON.stringify(payload.body),
    });
    const text = await response.text();
    let result: unknown = null;
    if (text) {
      try { result = JSON.parse(text); } catch { result = text; }
    }
    if (!response.ok) {
      const rejected = error('UPSTREAM_ERROR', 'Remnawave API rejected the request.', response.status);
      // Fork: keep the panel's own validation message (e.g. which field is wrong); it carries no credentials.
      const upstreamMessage = isObject(result) && typeof result.message === 'string' ? result.message : null;
      return upstreamMessage === null ? rejected : { error: { ...(rejected.error as Record<string, unknown>), upstreamMessage } };
    }
    return result;
  } catch {
    return { error: { code: 'UPSTREAM_UNAVAILABLE', kind: 'upstream', message: 'Remnawave API request failed.', retryable: true } };
  }
}
