// Remnawave 3.x compatibility layer.
//
// The MCP contract (operation names, payload validation) is generated from the 2.7.4 OpenAPI document.
// Remnawave 3.x dropped user UUIDs in favour of a numeric `id`, removed several lookup routes and renamed
// a handful of body fields. Instead of forking the whole contract, legacy-shaped requests are translated
// right before they hit the wire when the panel reports major version >= 3. A 2.x panel sees the request
// unchanged.

import { RemnawaveApiError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface PanelRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
}

/** Lookup that 3.x no longer serves directly: emulate via GET /api/users?filters=… with exact matching. */
export interface PanelUserLookup {
  readonly kind: 'user_lookup';
  readonly field: 'telegramId' | 'email' | 'tag';
  readonly value: string;
}

export type AdaptedRequest = ({ readonly kind: 'request' } & PanelRequest) | PanelUserLookup;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePanelMajor(version: unknown): number | null {
  if (typeof version !== 'string') {
    return null;
  }
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

function compatError(status: number, message: string): RemnawaveApiError {
  return new RemnawaveApiError(status, message, { message, errorCode: 'MCP_PANEL_V3_COMPAT' });
}

/** Convert a legacy user identifier (uuid field) into the numeric id 3.x expects. */
export function toUserId(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  if (typeof value === 'string' && UUID_RE.test(value.trim())) {
    throw compatError(
      400,
      `Remnawave 3.x has no user UUIDs: ${field} must be the numeric user id (field "id" in user objects), got a UUID.`,
    );
  }
  throw compatError(400, `Remnawave 3.x expects a numeric user id in ${field}.`);
}

const REMOVED_IN_V3: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/bandwidth-stats\/(nodes|users)\/[^/]+\/(users\/)?legacy/, 'legacy bandwidth-stats routes; use the non-legacy route'],
  [/^\/api\/ip-control\//, 'ip-control routes; 3.x moved them to /api/connections/*'],
  [/^\/api\/system\/tools\/happ\/encrypt/, 'happ encrypt tool'],
];

// Paths whose segment right after the prefix is a user id in 3.x (a user UUID in 2.x).
const USER_ID_PATH_PREFIXES: ReadonlyArray<readonly [RegExp, ReadonlySet<string>]> = [
  [/^(\/api\/users\/)([^/?]+)/, new Set(['by-username', 'by-short-uuid', 'bulk', 'resolve', 'tags', 'stream'])],
  [/^(\/api\/hwid\/devices\/)([^/?]+)/, new Set(['delete', 'delete-all', 'stats', 'top-users'])],
  [/^(\/api\/metadata\/user\/)([^/?]+)/, new Set()],
  [/^(\/api\/subscriptions\/connection-keys\/)([^/?]+)/, new Set()],
  [/^(\/api\/subscriptions\/by-id\/)([^/?]+)/, new Set()],
  [/^(\/api\/bandwidth-stats\/users\/)([^/?]+)/, new Set()],
];

const REMOVED_SUBSCRIPTION_SETTINGS_FIELDS = [
  'happAnnounce',
  'happRouting',
  'isProfileWebpageUrlEnabled',
  'profileTitle',
  'profileUpdateInterval',
  'supportLink',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rename(body: Record<string, unknown>, from: string, to: string, convert: (value: unknown) => unknown = (v) => v): void {
  if (Object.hasOwn(body, from)) {
    if (!Object.hasOwn(body, to)) {
      body[to] = convert(body[from]);
    }
    delete body[from];
  }
}

function adaptHostBody(input: Record<string, unknown>): Record<string, unknown> {
  const body = { ...input };
  if (Object.hasOwn(body, 'excludedInternalSquads')) {
    const squads = body.excludedInternalSquads;
    if (!Object.hasOwn(body, 'internalSquads') && Array.isArray(squads)) {
      body.internalSquads = { mode: 'EXCLUDE', squads };
    }
    delete body.excludedInternalSquads;
  }
  rename(body, 'tag', 'tags', (tag) => (typeof tag === 'string' && tag !== '' ? [tag] : []));
  rename(body, 'xHttpExtraParams', 'xhttpExtraParams');
  delete body.allowInsecure;
  return body;
}

function adaptBody(method: HttpMethod, path: string, input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }
  const body: Record<string, unknown> = { ...input };

  if (path === '/api/users' && method === 'PATCH') {
    rename(body, 'uuid', 'id', (value) => toUserId(value, 'uuid'));
    return body;
  }
  if (path === '/api/users' && method === 'POST') {
    delete body.uuid; // 3.x assigns the id itself
    return body;
  }
  if (path === '/api/users/resolve') {
    rename(body, 'uuid', 'id', (value) => toUserId(value, 'uuid'));
    return body;
  }
  if (path.startsWith('/api/users/bulk/')) {
    rename(body, 'uuids', 'userIds', (value) =>
      Array.isArray(value) ? value.map((entry, index) => toUserId(entry, `uuids[${index}]`)) : value,
    );
    return body;
  }
  if (path.startsWith('/api/hwid/devices')) {
    rename(body, 'userUuid', 'userId', (value) => toUserId(value, 'userUuid'));
    return body;
  }
  if (path === '/api/hosts' && (method === 'POST' || method === 'PATCH')) {
    return adaptHostBody(body);
  }
  if (path === '/api/hosts/bulk/update') {
    return adaptHostBody(body);
  }
  if (path === '/api/external-squads' && method === 'PATCH') {
    if (Object.hasOwn(body, 'responseHeaders')) {
      const headers = body.responseHeaders;
      if (isRecord(headers) && !Object.hasOwn(body, 'responseHeadersAdd')) {
        body.responseHeadersAdd = headers;
      }
      delete body.responseHeaders;
    }
    return body;
  }
  if (path === '/api/subscription-settings' && method === 'PATCH') {
    const removed = REMOVED_SUBSCRIPTION_SETTINGS_FIELDS.filter((field) => Object.hasOwn(body, field));
    if (removed.length > 0) {
      throw compatError(
        400,
        `Remnawave 3.x removed subscription-settings fields ${removed.join(', ')} (moved into customResponseHeaders); update them there.`,
      );
    }
    return body;
  }
  if (path === '/api/tokens' && method === 'POST') {
    rename(body, 'tokenName', 'name');
    return body;
  }
  return body;
}

/**
 * Translate one legacy-shaped request for a 3.x panel. Throws RemnawaveApiError for requests that
 * cannot be expressed on 3.x (user UUIDs, removed routes) so callers get a clear message instead of a 404.
 */
export function adaptRequestForV3(request: PanelRequest): AdaptedRequest {
  const [pathname, query = ''] = request.path.split('?', 2) as [string, string?];
  const suffix = query === '' ? '' : `?${query}`;

  for (const [pattern, what] of REMOVED_IN_V3) {
    if (pattern.test(pathname)) {
      throw compatError(404, `Remnawave 3.x removed ${what} (${request.method} ${pathname}).`);
    }
  }

  const lookup = /^\/api\/users\/by-(telegram-id|email|tag)\/([^/]+)$/.exec(pathname);
  if (lookup !== null && request.method === 'GET') {
    const field = lookup[1] === 'telegram-id' ? 'telegramId' : (lookup[1] as 'email' | 'tag');
    return { kind: 'user_lookup', field, value: decodeURIComponent(lookup[2] ?? '') };
  }

  let path = pathname;
  let method = request.method;
  let body = request.body;

  const byId = /^\/api\/users\/by-id\/([^/]+)$/.exec(path);
  if (byId !== null) {
    path = `/api/users/${byId[1]}`;
  }
  path = path.replace(/^\/api\/subscriptions\/by-uuid\//, '/api/subscriptions/by-id/');

  if (path === '/api/hosts/bulk/set-port' || path === '/api/hosts/bulk/set-inbound') {
    path = '/api/hosts/bulk/update';
    method = 'PATCH';
  }

  for (const [pattern, reserved] of USER_ID_PATH_PREFIXES) {
    const match = pattern.exec(path);
    if (match !== null) {
      const segment = decodeURIComponent(match[2] ?? '');
      if (!reserved.has(segment)) {
        const userId = toUserId(segment, 'user id path parameter');
        path = path.replace(pattern, `$1${userId}`);
      }
      break;
    }
  }

  body = adaptBody(method, path, body);
  return { kind: 'request', method, path: `${path}${suffix}`, ...(body === undefined ? {} : { body }) };
}

export function matchesUserLookup(user: unknown, lookup: PanelUserLookup): boolean {
  if (!isRecord(user)) {
    return false;
  }
  const actual = user[lookup.field];
  if (actual === null || actual === undefined) {
    return false;
  }
  if (lookup.field === 'email') {
    return String(actual).toLowerCase() === lookup.value.toLowerCase();
  }
  return String(actual) === lookup.value;
}
