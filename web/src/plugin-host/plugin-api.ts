/**
 * The fetch helper a plugin page calls its own routes with.
 *
 * Bound to one plugin's prefix, so `api.get('/summary')` reaches that plugin's
 * `GET /summary` and nothing else. Errors surface the runtime's `error` field,
 * the same shape `runtime-client.ts` reads, so a page can show the message its
 * own handler produced.
 */

import { ApiError } from '@/api/errors';

export interface PluginApi {
  get<T = unknown>(path: string, params?: Record<string, string | number | boolean>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  /** The URL of a file the plugin ships in `public/`. */
  assetUrl(name: string): string;
}

function join(pluginId: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `/agents/prism-plugins/${encodeURIComponent(pluginId)}/api${suffix}`;
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string };
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
      } catch {
        message = raw.slice(0, 300);
      }
    }
    throw new ApiError(message, {});
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function pluginApi(pluginId: string): PluginApi {
  const body = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value));

  return {
    get: <T>(path: string, params?: Record<string, string | number | boolean>) => {
      const query = params
        ? `?${new URLSearchParams(
            Object.entries(params).map(([k, v]) => [k, String(v)]),
          ).toString()}`
        : '';
      return send<T>(`${join(pluginId, path)}${query}`);
    },
    post: <T>(path: string, value?: unknown) =>
      send<T>(join(pluginId, path), { method: 'POST', body: body(value) }),
    put: <T>(path: string, value?: unknown) =>
      send<T>(join(pluginId, path), { method: 'PUT', body: body(value) }),
    patch: <T>(path: string, value?: unknown) =>
      send<T>(join(pluginId, path), { method: 'PATCH', body: body(value) }),
    del: <T>(path: string) => send<T>(join(pluginId, path), { method: 'DELETE' }),
    assetUrl: (name: string) =>
      `/agents/prism-plugins/${encodeURIComponent(pluginId)}/asset/${name.replace(/^\/+/, '')}`,
  };
}
