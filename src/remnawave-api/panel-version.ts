// Fork (whoiam): detect the panel major once from GET /api/system/metadata so the same binary can serve
// a Remnawave 2.8.x panel (XO) and a 3.4.x panel (WhoIAm) without per-panel configuration.

export type PanelFamily = 'v2' | 'v3';

export interface PanelFamilyResolverOptions {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class PanelVersionUnknownError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PanelVersionUnknownError';
  }
}

export function parsePanelMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Returns a memoised resolver. A successful probe is cached for the process lifetime; a failed one is not,
 * so the next tool call retries instead of pinning a guess.
 */
export function createPanelFamilyResolver(options: PanelFamilyResolverOptions): () => Promise<{ family: PanelFamily; version: string }> {
  let cached: Promise<{ family: PanelFamily; version: string }> | null = null;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/system/metadata`;

  const probe = async (): Promise<{ family: PanelFamily; version: string }> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          'Content-Type': 'application/json',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '127.0.0.1',
        },
      });
    } catch {
      throw new PanelVersionUnknownError('Remnawave panel is unreachable: GET /api/system/metadata failed.');
    }
    if (!response.ok) {
      throw new PanelVersionUnknownError(`Remnawave panel answered ${response.status} to GET /api/system/metadata.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PanelVersionUnknownError('Remnawave panel returned non-JSON metadata.');
    }
    const body = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).response : undefined;
    const version = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).version : undefined;
    const major = parsePanelMajor(version);
    if (major === null || typeof version !== 'string') {
      throw new PanelVersionUnknownError('Remnawave panel metadata has no version.');
    }
    if (major === 2) return { family: 'v2', version };
    if (major === 3) return { family: 'v3', version };
    throw new PanelVersionUnknownError(`Remnawave panel version ${version} is not supported (expected 2.x or 3.x).`);
  };

  return () => {
    if (cached === null) {
      const attempt = probe();
      cached = attempt;
      attempt.catch(() => {
        if (cached === attempt) cached = null;
      });
    }
    return cached;
  };
}
