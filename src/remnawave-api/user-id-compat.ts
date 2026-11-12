// Accept Remnawave 3.x user identifiers in the 2.7.4-shaped MCP contract.
//
// 3.x identifies users by a numeric `id` (path `{userId}`, bodies `id` / `userIds` / `userId`). The MCP
// payload contract still names these fields `uuid` / `uuids` / `userUuid`. Before validation the 3.x
// spellings are folded into the legacy names, and the `format: uuid` constraint is relaxed for those
// fields, so the same call works on both panel generations; the client translates back on the wire
// (src/client/panel-compat.ts).

import { REMNAWAVE_OPENAPI_EXTRACT } from './generated/operations.js';

const USER_SCOPED_PATH = /^\/api\/(users(\/|$)|hwid\/devices|subscriptions\/(by-uuid|connection-keys)\/|bandwidth-stats\/users\/|metadata\/user\/)/;

// Fields that carry a user identifier in user-scoped operations.
export const USER_ID_FIELDS: ReadonlySet<string> = new Set(['uuid', 'uuids', 'userUuid']);

function operationPath(operationKey: string): string | null {
  const operation = REMNAWAVE_OPENAPI_EXTRACT.operations.find((entry) => entry.key === operationKey);
  return operation === undefined ? null : operation.path;
}

export function isUserScopedOperation(operationKey: string): boolean {
  const path = operationPath(operationKey);
  return path !== null && USER_SCOPED_PATH.test(path);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function moveField(payload: Record<string, unknown>, from: string, to: string, convert: (value: unknown) => unknown): void {
  if (Object.hasOwn(payload, from) && !Object.hasOwn(payload, to)) {
    payload[to] = convert(payload[from]);
    delete payload[from];
  }
}

const asIdString = (value: unknown): unknown => (typeof value === 'number' ? String(value) : value);

/** Fold 3.x identifier spellings (id, userId, userIds) into the legacy payload fields. */
export function applyUserIdAliases(domain: string, operation: string, payload: unknown): unknown {
  if (!isPlainRecord(payload) || operation === '') {
    return payload;
  }
  const key = `${domain}.${operation}`;
  const path = operationPath(key);
  if (path === null || !USER_SCOPED_PATH.test(path)) {
    return payload;
  }
  // users.resolve and users.get_by_id legitimately take `id`; users.create has no identifier to alias.
  if (key === 'users.resolve' || key === 'users.get_by_id' || key === 'users.create') {
    return payload;
  }

  const next: Record<string, unknown> = { ...payload };
  if (path.includes('{userUuid}') || path.startsWith('/api/hwid/devices')) {
    moveField(next, 'userId', 'userUuid', asIdString);
  }
  if (path.includes('{uuid}') || path === '/api/users') {
    moveField(next, 'userId', 'uuid', asIdString);
    moveField(next, 'id', 'uuid', asIdString);
  }
  if (path.startsWith('/api/users/bulk/')) {
    moveField(next, 'userIds', 'uuids', (value) => (Array.isArray(value) ? value.map(asIdString) : value));
  }
  return next;
}

/** Remove `format: uuid` from user identifier fields so numeric 3.x ids pass the 2.7.4 schema. */
export function relaxUserIdFormats<T>(schema: T): T {
  if (!isPlainRecord(schema)) {
    return schema;
  }
  const properties = schema.properties;
  if (!isPlainRecord(properties)) {
    return schema;
  }
  const relaxed: Record<string, unknown> = { ...properties };
  for (const field of USER_ID_FIELDS) {
    const property = relaxed[field];
    if (!isPlainRecord(property)) {
      continue;
    }
    if (property.type === 'array' && isPlainRecord(property.items)) {
      const { format: _format, ...items } = property.items;
      relaxed[field] = { ...property, items };
    } else {
      const { format: _format, ...rest } = property;
      relaxed[field] = rest;
    }
  }
  return { ...schema, properties: relaxed };
}
