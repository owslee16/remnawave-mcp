import { describe, expect, test, vi } from 'vitest';

import { RemnawaveClient } from '../src/client/client.js';
import { adaptRequestForV3, parsePanelMajor } from '../src/client/panel-compat.js';
import { getSupportedOperationSchema } from '../src/remnawave-api/schema.js';
import { applyUserIdAliases } from '../src/remnawave-api/user-id-compat.js';

const UUID = '0b6d5f3e-1c2a-4b7e-9a51-3f2e4d6c8a10';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function v3User(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    shortUuid: `short-${id}`,
    username: `user-${id}`,
    status: 'ACTIVE',
    trafficLimitBytes: 0,
    trafficLimitStrategy: 'MONTH',
    expireAt: '2026-12-01T00:00:00.000Z',
    telegramId: null,
    email: null,
    tag: null,
    activeInternalSquads: [],
    userTraffic: { usedTrafficBytes: 0, lifetimeUsedTrafficBytes: 0, onlineAt: null },
    ...extra,
  };
}

describe('parsePanelMajor', () => {
  test('reads the major from metadata versions', () => {
    expect(parsePanelMajor('3.4.10')).toBe(3);
    expect(parsePanelMajor('2.8.1')).toBe(2);
    expect(parsePanelMajor(undefined)).toBeNull();
  });
});

describe('adaptRequestForV3', () => {
  test('rewrites removed lookup routes', () => {
    expect(adaptRequestForV3({ method: 'GET', path: '/api/users/by-id/42' })).toMatchObject({ kind: 'request', path: '/api/users/42' });
    expect(adaptRequestForV3({ method: 'GET', path: '/api/subscriptions/by-uuid/42' })).toMatchObject({ path: '/api/subscriptions/by-id/42' });
    expect(adaptRequestForV3({ method: 'GET', path: '/api/users/by-telegram-id/777' })).toEqual({ kind: 'user_lookup', field: 'telegramId', value: '777' });
    expect(adaptRequestForV3({ method: 'GET', path: '/api/users/by-email/a%40b.c' })).toEqual({ kind: 'user_lookup', field: 'email', value: 'a@b.c' });
  });

  test('keeps numeric user ids and refuses user UUIDs with a clear message', () => {
    expect(adaptRequestForV3({ method: 'POST', path: '/api/users/42/actions/disable' })).toMatchObject({ path: '/api/users/42/actions/disable' });
    expect(adaptRequestForV3({ method: 'GET', path: '/api/users/by-username/bob' })).toMatchObject({ path: '/api/users/by-username/bob' });
    expect(adaptRequestForV3({ method: 'GET', path: '/api/hwid/devices/stats' })).toMatchObject({ path: '/api/hwid/devices/stats' });
    expect(() => adaptRequestForV3({ method: 'GET', path: `/api/users/${UUID}` })).toThrow(/no user UUIDs/);
    expect(() => adaptRequestForV3({ method: 'GET', path: `/api/subscriptions/connection-keys/${UUID}` })).toThrow(/numeric user id/);
  });

  test('translates user bodies', () => {
    expect(adaptRequestForV3({ method: 'PATCH', path: '/api/users', body: { uuid: '42', status: 'DISABLED' } })).toMatchObject({ body: { id: 42, status: 'DISABLED' } });
    expect(adaptRequestForV3({ method: 'POST', path: '/api/users/resolve', body: { uuid: '7' } })).toMatchObject({ body: { id: 7 } });
    expect(adaptRequestForV3({ method: 'POST', path: '/api/users/bulk/delete', body: { uuids: ['1', 2] } })).toMatchObject({ body: { userIds: [1, 2] } });
    expect(adaptRequestForV3({ method: 'POST', path: '/api/hwid/devices/delete-all', body: { userUuid: '9' } })).toMatchObject({ body: { userId: 9 } });
    expect(() => adaptRequestForV3({ method: 'PATCH', path: '/api/users', body: { uuid: UUID } })).toThrow(/no user UUIDs/);
  });

  test('translates host and squad bodies', () => {
    const host = adaptRequestForV3({
      method: 'PATCH',
      path: '/api/hosts',
      body: { uuid: 'h1', excludedInternalSquads: ['s1'], tag: 'EU', xHttpExtraParams: { a: 1 }, allowInsecure: false },
    });
    expect(host).toMatchObject({ body: { uuid: 'h1', internalSquads: { mode: 'EXCLUDE', squads: ['s1'] }, tags: ['EU'], xhttpExtraParams: { a: 1 } } });
    expect((host as { body: Record<string, unknown> }).body).not.toHaveProperty('excludedInternalSquads');
    expect((host as { body: Record<string, unknown> }).body).not.toHaveProperty('allowInsecure');

    expect(adaptRequestForV3({ method: 'POST', path: '/api/hosts/bulk/set-port', body: { uuids: ['h1'], port: 443 } }))
      .toMatchObject({ method: 'PATCH', path: '/api/hosts/bulk/update', body: { uuids: ['h1'], port: 443 } });
    expect(adaptRequestForV3({ method: 'PATCH', path: '/api/external-squads', body: { uuid: 'x', responseHeaders: { A: 'b' } } }))
      .toMatchObject({ body: { uuid: 'x', responseHeadersAdd: { A: 'b' } } });
    expect(() => adaptRequestForV3({ method: 'PATCH', path: '/api/subscription-settings', body: { uuid: 'x', profileTitle: 't' } })).toThrow(/customResponseHeaders/);
    expect(() => adaptRequestForV3({ method: 'GET', path: '/api/bandwidth-stats/users/42/legacy' })).toThrow(/removed/);
  });
});

describe('user identifier aliases before validation', () => {
  test('folds 3.x spellings into the legacy payload fields', () => {
    expect(applyUserIdAliases('users', 'update', { id: 42, status: 'ACTIVE' })).toEqual({ uuid: '42', status: 'ACTIVE' });
    expect(applyUserIdAliases('users', 'disable', { userId: 42 })).toEqual({ uuid: '42' });
    expect(applyUserIdAliases('users', 'bulk_delete', { userIds: [1, 2] })).toEqual({ uuids: ['1', '2'] });
    expect(applyUserIdAliases('hwid', 'get_user_devices', { userId: 5 })).toEqual({ userUuid: '5' });
    expect(applyUserIdAliases('users', 'resolve', { id: 5 })).toEqual({ id: 5 });
    expect(applyUserIdAliases('nodes', 'get', { id: 5 })).toEqual({ id: 5 });
  });

  test('numeric ids pass the 2.7.4 schemas for user-scoped operations', () => {
    expect(getSupportedOperationSchema('users', 'bulk_delete').validatePayload({ uuids: ['1', '2'] })).toEqual([]);
    expect(getSupportedOperationSchema('users', 'update').validatePayload({ uuid: '42', status: 'DISABLED' })).toEqual([]);
  });
});

describe('RemnawaveClient on a 3.x panel', () => {
  function makeClient(version: string, routes: (url: URL, init: RequestInit) => Response) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname === '/api/system/metadata') {
        return json({ response: { version } });
      }
      return routes(url, init ?? {});
    });
    const client = new RemnawaveClient({ baseUrl: 'https://panel.test', apiToken: 't', fetch: fetchMock as typeof fetch, panelMajor: 'auto' });
    return { client, calls, fetchMock };
  }

  test('normalizes users without uuid, probing the version once', async () => {
    const { client, calls } = makeClient('3.4.10', () => json({ response: { total: 1, users: [v3User(42)] } }));
    const users = await client.getUsers();
    await client.getUsers();
    expect(users.items[0]).toMatchObject({ uuid: '42', id: 42, username: 'user-42' });
    expect(calls.filter((call) => call.path === '/api/system/metadata')).toHaveLength(1);
  });

  test('emulates by-telegram-id with exact matching over the filtered list', async () => {
    const { client, calls } = makeClient('3.4.10', () =>
      json({ response: { total: 2, users: [v3User(1, { telegramId: 777 }), v3User(2, { telegramId: 17770 })] } }));
    const contract = { key: 'users.get_by_telegram_id', openapi: { method: 'get', path: '/api/users/by-telegram-id/{telegramId}' } };
    const result = await client.executeOpenApiOperation(contract as never, { telegramId: '777' });
    expect(result).toEqual({ response: [expect.objectContaining({ id: 1 })] });
    const listCall = calls.find((call) => call.path.startsWith('/api/users?'));
    expect(decodeURIComponent(listCall?.path ?? '')).toContain('filters=[{"id":"telegramId","value":"777"}]');
  });

  test('wraps 204 deletes and translates bulk bodies', async () => {
    const { client, calls } = makeClient('3.4.10', () => new Response(null, { status: 204 }));
    const deleted = await client.executeOpenApiOperation(
      { key: 'users.delete', openapi: { method: 'delete', path: '/api/users/{uuid}' } } as never,
      { uuid: '42' },
    );
    expect(deleted).toEqual({ response: { isDeleted: true } });
    await client.executeOpenApiOperation(
      { key: 'users.bulk_delete', openapi: { method: 'post', path: '/api/users/bulk/delete' } } as never,
      { uuids: ['1', '2'] },
    );
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/users/bulk/delete', body: { userIds: [1, 2] } });
  });

  test('leaves requests untouched on a 2.x panel', async () => {
    const { client, calls } = makeClient('2.8.1', () => json({ response: [] }));
    await client.executeOpenApiOperation(
      { key: 'users.get_by_telegram_id', openapi: { method: 'get', path: '/api/users/by-telegram-id/{telegramId}' } } as never,
      { telegramId: '777' },
    );
    expect(calls.at(-1)?.path).toBe('/api/users/by-telegram-id/777');
  });

  test('without panelMajor the client never probes (legacy default)', async () => {
    const fetchMock = vi.fn(async () => json({ response: { total: 0, users: [] } }));
    const client = new RemnawaveClient({ baseUrl: 'https://panel.test', apiToken: 't', fetch: fetchMock as unknown as typeof fetch });
    await client.getUsers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
