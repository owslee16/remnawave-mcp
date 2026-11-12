// Fork (whoiam): one binary for a Remnawave 2.8.x panel and a 3.4.x panel + split read/write tools.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { loadRuntimeConfig, resolveRemnawaveRouteMode } from '../src/runtime/config.js';
import { createPanelFamilyResolver, parsePanelMajor } from '../src/remnawave-api/panel-version.js';
import { REMNAWAVE_V2_ROUTER, REMNAWAVE_V3_ROUTER } from '../src/remnawave-api/v3.js';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }>>());

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool = (name: string, _meta: unknown, handler: (args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }>) => {
      tools.set(name, handler);
    };
    connect = async () => undefined;
    close = async () => undefined;
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    public onclose: (() => void) | null = null;
    public onerror: ((error: Error) => void) | null = null;
  },
}));
vi.mock('../src/runtime/process-guard.js', () => ({ installProcessGuards: vi.fn() }));
vi.mock('../src/runtime/logger.js', () => ({ createStderrLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function panelFetch(version: string) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/system/metadata')) return json({ response: { version } });
    return json({ response: { url } });
  });
}

function env(version: string) {
  return { REMNAWAVE_BASE_URL: 'https://panel.example.test', REMNAWAVE_API_TOKEN: 'token', REMNAWAVE_VERSION: version };
}

afterEach(() => {
  vi.unstubAllGlobals();
  tools.clear();
});

describe('version gate', () => {
  test.each(['auto', '2.7.4', '2.8.1', '3.4.10', '3.5.0'])('%s is accepted and probes the panel', (value) => {
    const config = loadRuntimeConfig(env(value));
    expect(config.startupDiagnostics.remnawaveVersion.status).toBe('supported');
    expect(resolveRemnawaveRouteMode(config)).toBe('auto');
  });

  test('upstream pins keep upstream routing', () => {
    expect(resolveRemnawaveRouteMode(loadRuntimeConfig(env('3.3.2')))).toBe('legacy-3.3.2');
    expect(resolveRemnawaveRouteMode(loadRuntimeConfig(env('3.4.4')))).toBe('openapi-3.4.4');
  });

  test.each(['2.6.4', '2.9.0', '4.0.0', 'latest'])('%s stays unsupported', (value) => {
    expect(loadRuntimeConfig(env(value)).startupDiagnostics.remnawaveVersion.status).toBe('unsupported');
  });
});

describe('panel family resolver', () => {
  test('parses majors', () => {
    expect(parsePanelMajor('2.8.1')).toBe(2);
    expect(parsePanelMajor('v3.4.10')).toBe(3);
    expect(parsePanelMajor(undefined)).toBeNull();
  });

  test('caches a successful probe and retries a failed one', async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return json({ message: 'down' }, 502);
      return json({ response: { version: '3.4.10' } });
    });
    const resolve = createPanelFamilyResolver({ baseUrl: 'https://panel.example.test/', apiToken: 't', fetch });
    await expect(resolve()).rejects.toThrow('502');
    await expect(resolve()).resolves.toEqual({ family: 'v3', version: '3.4.10' });
    await expect(resolve()).resolves.toEqual({ family: 'v3', version: '3.4.10' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith('https://panel.example.test/api/system/metadata', expect.objectContaining({ method: 'GET' }));
  });
});

describe('pinned 2.8.1 pass-through contract', () => {
  test('keeps uuid-addressed 2.x user routes', async () => {
    const fetch = vi.fn(async () => json({ response: { uuid: 'u' } }));
    await REMNAWAVE_V2_ROUTER.route({ domain: 'users', operation: 'get_user_by_short_uuid', payload: { shortUuid: 'abc' } }, { baseUrl: 'https://p.test', apiToken: 't', fetch });
    expect(fetch).toHaveBeenCalledWith('https://p.test/api/users/by-short-uuid/abc', expect.objectContaining({ method: 'GET' }));
    expect(REMNAWAVE_V2_ROUTER.describeAccess('users', 'get_user_by_uuid')).toEqual({ write: false });
    expect(REMNAWAVE_V2_ROUTER.describeAccess('users', 'create_user')).toEqual({ write: true });
    expect(REMNAWAVE_V3_ROUTER.describeAccess('users', 'get_user_by_uuid')).toBeNull();
  });

  test('surfaces the panel validation message on rejection', async () => {
    const fetch = vi.fn(async () => json({ message: 'Invalid shortUuid', statusCode: 400 }, 400));
    const result = await REMNAWAVE_V3_ROUTER.route({ domain: 'users', operation: 'get_user_by_short_uuid', payload: { shortUuid: 'x' } }, { baseUrl: 'https://p.test', apiToken: 't', fetch });
    expect(result).toMatchObject({ error: { code: 'UPSTREAM_ERROR', statusCode: 400, upstreamMessage: 'Invalid shortUuid' } });
  });
});

describe('server: auto-detected contract behind split read/write tools', () => {
  async function start(panelVersion: string) {
    const fetch = panelFetch(panelVersion);
    vi.stubGlobal('fetch', fetch);
    const { startServer } = await import('../src/server.js');
    await startServer(loadRuntimeConfig(env('2.7.4')));
    return fetch;
  }

  test('registers remnawave_api, remnawave_read and remnawave_write', async () => {
    await start('3.4.10');
    expect([...tools.keys()]).toEqual(['remnawave_api', 'remnawave_read', 'remnawave_write']);
  });

  test('a 3.x panel gets numeric-id 3.4.4 routes', async () => {
    const fetch = await start('3.4.10');
    const result = await tools.get('remnawave_read')!({ domain: 'users', operation: 'get_user_by_id', payload: { userId: 7 } });
    expect(result.isError).toBeUndefined();
    expect(fetch).toHaveBeenLastCalledWith('https://panel.example.test/api/users/7', expect.objectContaining({ method: 'GET' }));
  });

  test('a 2.x panel gets 2.8.1 routes', async () => {
    const fetch = await start('2.8.1');
    await tools.get('remnawave_read')!({ domain: 'users', operation: 'get_user_by_uuid', payload: '{"uuid":"00000000-0000-4000-8000-000000000001"}' });
    expect(fetch).toHaveBeenLastCalledWith('https://panel.example.test/api/users/00000000-0000-4000-8000-000000000001', expect.objectContaining({ method: 'GET' }));
  });

  test('remnawave_read refuses writes before any panel call beyond metadata', async () => {
    const fetch = await start('3.4.10');
    const result = await tools.get('remnawave_read')!({ domain: 'users', operation: 'create_user', payload: { body: { username: 'x' } } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'READ_ONLY_TOOL' } } });
    const describe = await tools.get('remnawave_read')!({ domain: 'users', operation: 'create_user' });
    expect(describe.isError).toBeUndefined();
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/api/system/metadata'))).toBe(true);
  });

  test('remnawave_write still asks for a confirmation token', async () => {
    await start('3.4.10');
    const result = await tools.get('remnawave_write')!({ domain: 'users', operation: 'create_user', payload: { body: { username: 'x' } } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFIRMATION_REQUIRED' } } });
  });
});
